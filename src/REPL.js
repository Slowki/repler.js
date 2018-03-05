//@flow
import type Compiler, { CompileResult } from './Compiler';
import * as babel from 'babel-core';
import * as t from 'babel-types';

import chokidar from 'chokidar';
import chalk from 'chalk';

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

export default class REPL {
    evalFunction : REPLEvalFunction;
    replInstance : repl.REPLServer;
    compiler : Compiler;

    /**
     * A map from an absolute file path to a file dirty state, true if the file has changed since being require'd
     * @private
     */
    watchedFiles : Map<string, boolean>;

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

        this.watchedFiles = new Map()
        this.replBindingList = new Map()

        const nodeReplOptions = Object.assign({}, options, ({
            eval: this._evalWrapper.bind(this)
        } : any));
        this.replInstance = repl.start(nodeReplOptions);
        (this.replInstance.context : any).__replerRequire = this.__replerRequire.bind(this);

        this.watcher
            .on('change', filePath => {
                // When a file changes reload the associated bindings in the REPL,
                // TODO proper dependency tree analysis:
                //      Traverse the repl module's children creating a set of modules to reload,
                //      remove those modules from the cache, then reload any removed children

                const absPath = path.resolve(filePath);
                this.watchedFiles.set(absPath, true);
                const bindings = Array.from((this.replBindingList.get(absPath) : any).entries());

                // Create new import expression
                const importIdentifierName = this.compiler.importIdentifierFromModulePath(absPath);
                const importIdentifier = t.identifier(importIdentifierName);

                const ast = t.program([
                    t.expressionStatement(t.assignmentExpression('=', importIdentifier, t.callExpression(t.identifier("__replerRequire"), [t.stringLiteral(absPath), t.identifier('module')])))
                ].concat(
                    Array.from((this.replBindingList.get(absPath) : ast).entries()).map(([bindingName, iname]) => t.expressionStatement(t.assignmentExpression('=', t.identifier(bindingName), t.memberExpression(importIdentifier, t.identifier(iname)))))
                ));


                let source;
                if (bindings.length == 0) {
                    source = `import "${filePath}";`
                } else {
                    source = `import {\n${bindings.map(([name, imprt]) => imprt === name ? `    ${name}` : `    ${imprt} as ${name}`).join(',\n')}\n} from "${filePath}";`
                }

                const transformed = babel.transformFromAst(ast, null, {}).code;

                console.log();
                console.log(chalk.green(`${filePath} reloading\n${source}`));
                vm.runInThisContext(transformed);
                this.replInstance.displayPrompt(true);
            })
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
            this.watchedFiles.forEach((_, path) => this.watcher.unwatch(path));
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
    _eval({ code }: CompileResult, context: vm$Context, filename : string) : Promise<mixed> {
        try {
            // TODO source map support
            return Promise.resolve(vm.runInThisContext(code, { filename }));
        } catch (e) {
            return Promise.reject(e);
        }
    }

    _evalWrapper(code: string, context: vm$Context, filename : string, callback: Function) : void {
        let result;
        try {
            const compileResult = this.compiler.compile(this, code, context, filename);
            this.evalFunction(compileResult, context, filename)
                        .then(result => callback(undefined, result))
                        .catch(err => {
                            console.error(err);
                            callback(err, null);
                        });
        } catch (e) {
            console.error(e);
            return callback(e, null);
        }
    }

    __replerRequire(modulePath : string, callingModule : any) : mixed {
        if (modulePath !== null && !this.watchedFiles.has(modulePath)) {
            this.watcher.add(modulePath);
            this.watchedFiles.set(modulePath, true);
        }

        if (this.watchedFiles.get(modulePath) || !require.cache[modulePath]) {
            this.watchedFiles.set(modulePath, false);
            delete require.cache[modulePath];

            if (!modulePath.endsWith('json')) {
                const script = fs.readFileSync(modulePath, 'utf-8');
                const transformed = this.compiler.compile(null, script, null, modulePath);
                const newModule = new Module(modulePath, callingModule);
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
}
