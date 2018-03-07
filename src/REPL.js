//@flow
import type Compiler, { CompileResult } from './Compiler';

import chokidar from 'chokidar';
import chalk from 'chalk';
import { SourceMapConsumer } from 'source-map';

import fs from 'fs';
import path from 'path';
import repl from 'repl';
// $FlowExpectedError
import Module from 'module';
import vm from 'vm';

export type REPLEvalFunction = (code: CompileResult, context: vm$Context, filename : string) => Promise<mixed>;
export type REPLEvent = 'exit' | 'reset' | 'module-reloaded';

export type REPLOptions = {
    prompt?: string;
    input?: stream$Readable;
    output?: stream$Writable;
    terminal?: boolean;
    eval?: REPLEvalFunction;
    compiler: Compiler;
    useColors?: boolean;
    useGlobal?: boolean;
    ignoreUndefined?: boolean;
    writer?: Function;
    completer?: Function;
    replMode?: (typeof repl.REPL_MODE_SLOPPY | typeof repl.REPL_MODE_STRICT | typeof repl.REPL_MODE_MAGIC);
    breakEvalOnSigint?: boolean;
};

/**
 * Overwrite v8's default stack trace string generation
 */
Error.prepareStackTrace = function prepareStackTrace(error : any, stack : any[]) : ?string {
    function formatCallStack(callStack : any) : string {
        if (callStack.isNative())
            return callStack.toString();

        const filename = callStack.getFileName();
        const functionName = callStack.getFunctionName();
        const methodName = callStack.getMethodName();
        let sourceMap;

        if (filename !== 'repl') {
            const loadedModule = require.cache[filename];
            if (!loadedModule)
                return callStack.toString();

            sourceMap = loadedModule.__sourceMap;
        } else {
            sourceMap = error.__replSourceMap;
        }

        if (!sourceMap)
            return callStack.toString();

        const position = sourceMap.originalPositionFor({
            line: callStack.getLineNumber(),
            column: callStack.getColumnNumber(),
            source: callStack.getFileName()
        });

        let errorString = `${position.source}:${position.line}:${position.column}`;
        if (functionName && !methodName) {
            errorString = `${functionName} (${errorString})`;
        } else if (functionName && methodName) {
            errorString = `${functionName} as ${methodName} (${errorString})`;
        }

        return errorString;
    }

    return chalk.red(error.toString() + stack.map(frame => '\n    at ' + formatCallStack(frame)).join(''));
}

export default class REPL {
    evalFunction : REPLEvalFunction;
    replInstance : repl.REPLServer;
    compiler : Compiler;

    /**
     * @private
     */
    watchedFiles : Set<string>;

    /**
     * A map from absolute file path to a map which maps import identifiers to properties of the imported modulePath
     * @protected
     */
    replBindingList : Map<string, Map<string, string>>;

    /**
     * chokidar watcher
     * @private
     */
    watcher : any;

    constructor(options : REPLOptions) {
        this.evalFunction = options.eval || this._eval;
        this.compiler = options.compiler;
        this.watcher = chokidar.watch([], {
            cwd: process.cwd()
        });

        this.watchedFiles = new Set()
        this.replBindingList = new Map()

        const nodeReplOptions = Object.assign({}, options, ({
            eval: this._evalWrapper.bind(this)
        } : any));
        this.replInstance = repl.start(nodeReplOptions);
        (this.replInstance.context : any).__replerRequire = this.__replerRequire.bind(this);

        this.watcher
            .on('change', this._handleModuleChange.bind(this))
            .on('unlink', filePath => {
                this.watcher.unwatch(filePath);
                this.watchedFiles.delete(path.resolve(filePath));
                this.printMessage(chalk.yellow(`${filePath} was removed`));
            })
            .on('error', error => {
                console.error(chalk.red(`Watcher error: ${error}`));
                process.exit(2);
            });

        this.replInstance.on('exit', () => this.watcher.close());
        this.replInstance.on('reset', () => {
            this.watchedFiles.forEach(path => this.watcher.unwatch(path));
            this.replBindingList.clear();
            this.watchedFiles.clear();
        });
    }

    // Getters //
    get context() : Object {
        return this.replInstance.context;
    }

    // Public Methods //
    on(event : REPLEvent, callback: Function) {
        throw new Error("Not Implemented");
    }

    printMessage(...args : mixed[]) : void {
        console.log();
        console.log(...args);
        this.replInstance.displayPrompt(true);
    }

    // Private  Methods //
    _eval({ code, sourceMap }: CompileResult, context: vm$Context, filename : string) : Promise<mixed> {
        try {
            const result = new vm.Script(code, {
                filename,
                displayErrors: false
            }).runInThisContext({
                filename,
                displayErrors: false
            });
            return Promise.resolve(result);
        } catch (e) {
            return new SourceMapConsumer(sourceMap).then(sourceMap => {
                e.__replSourceMap = sourceMap;
                return Promise.reject(e);
            });
        }
    }

    _evalWrapper(code: string, context: vm$Context, filename : string, callback: Function) : void {
        let result;
        try {
            const compileResult = this.compiler.compile(this, code, context, filename);
            this.evalFunction(compileResult, context, filename)
                .then(result => callback(undefined, result))
                .catch(err => {
                    err.stack; // Touch the stack so it gets generated
                    callback(err, null);
                });
        } catch (e) {
            e.stack; // Touch the stack so it gets generated
            return callback(e, null);
        }
    }

    __replerRequire(modulePath : string, callingModule : any) : mixed {
        if (modulePath !== null && !this.watchedFiles.has(modulePath)) {
            this.watchedFiles.add(modulePath);
            this.watcher.add(modulePath);
        }

        if (!require.cache[modulePath]) {
            if (!modulePath.endsWith('json')) {
                const script = fs.readFileSync(modulePath, 'utf-8');
                const transformed = this.compiler.compile(null, script, null, modulePath);
                const newModule = new Module(modulePath, callingModule);
                if (transformed.sourceMap) {
                    new SourceMapConsumer(transformed.sourceMap)
                        .then(sourceMap => {
                            newModule.__sourceMap = sourceMap;
                        })
                        .catch(err => console.warn(chalk.yellow(`Error loading source map for ${modulePath}`)))
                }
                newModule.paths = Module._nodeModulePaths(path.dirname(modulePath));
                newModule.filename = modulePath;
                require.cache[modulePath] = newModule;
                newModule._compile(transformed.code, modulePath);
            }
        }

        const module = callingModule.require(modulePath);
        if (module && module.__esModule) {
            return module;
        } else {
            return { default: module };
        }
    }

    /**
     * Remove a module from require.cache and delete the associated source map
     */
    _deleteModuleFromCache(module : string) {
        if (require.cache[module]) {
            if (require.cache[module].__sourceMap)
                require.cache[module].__sourceMap.destroy();

            delete require.cache[module];
        }
    }

    /**
     * Handle changes to the file at `filePath`
     * @arg filePath relative or absolute path to the changed file
     */
    _handleModuleChange(filePath : string) {
        const removedModules = new Set();
        const absPath = path.resolve(filePath);
        let previousCacheSize = Object.keys(require.cache);

        // Invalidate the reloaded file
        removedModules.add(absPath);
        this._deleteModuleFromCache(absPath);

        // Invalidate everything that depends on the reloaded file
        while (previousCacheSize !== Object.keys(require.cache)) {
            previousCacheSize = Object.keys(require.cache);

            const toRemove = [];

            for (const modPath in require.cache) {
                const mod = require.cache[modPath];
                for (const child of mod.children) {
                    if (removedModules.has(child.filename)) {
                        toRemove.push(modPath);
                        removedModules.add(modPath);
                        break;
                    }
                }
            }

            for (const modPath of toRemove) {
                this._deleteModuleFromCache(modPath);
            }

            break;
        }

        // Build the expressions to reload the invalidated modules imported from REPL
        let source = '';
        let reloadExprs = [];
        for (const [fp, bindingsMap] of this.replBindingList.entries()) {
            // If a module is in the cache then it hasn't changed, so skip it.
            if (require.cache[fp]) continue;

            const bindings : any = Array.from(bindingsMap.entries());

            // Create new import expressions
            const importIdentifierName = this.compiler.importIdentifierFromModulePath(fp);

            reloadExprs = reloadExprs.concat([
                `${importIdentifierName} = __replerRequire(${JSON.stringify(fp)}, module)`
            ]).concat(
                bindings.map(([name, imprt]) => {
                    if (imprt !== '*')
                        return `${name} = ${importIdentifierName}.${imprt}`;
                    else
                        return `${name} = ${importIdentifierName}`;
                })
            );

            if (bindings.length == 0) {
                source += `import "${filePath}";\n`
            } else {
                source += `import {\n${bindings.map(([name, imprt]) => imprt === name ? `    ${name}` : `    ${imprt} as ${name}`).join(',\n')}\n} from "${fp}";\n`
            }
        }

        // Tell the user things have changed
        console.log();
        console.log(chalk.green(`${filePath} changed\n${source}`));

        // Execute the import expressions
        if (reloadExprs.length > 0)
            vm.runInThisContext(reloadExprs.join(';\n'));

        this.replInstance.displayPrompt(true);
    }
}
