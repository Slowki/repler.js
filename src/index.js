#!/usr/bin/env node

import chokidar from 'chokidar';
import chalk from 'chalk';
import fsExtra from 'fs-extra';
import * as babel from 'babel-core';
import * as t from 'babel-types';
import yargs from 'yargs';

import repl from 'repl';
import path from 'path';
import vm from 'vm';
import Module from 'module';
import fs from 'fs';

const argv = yargs
    .usage('Usage: $0')
    .version()
    .help('h')
    .alias('v', 'version')
    .alias('h', 'help')
    .argv;

const cwd = process.cwd();
const file = path.resolve(argv._[0] || 'index.js');

const watcher = chokidar.watch(file, {
    cwd: process.cwd(),
    ignored: /node_modules/,
    persistent: false
});

const watchedFiles = new Map();
const replBindingList = new Map();


function createBindingExpression(moduleName, bindingList) {
    const importIdentifier = t.identifier('__repler_resolve_' + moduleName.replace(/[\/\.-]/g, '_'));

    let exprs = [
        t.expressionStatement(t.assignmentExpression('=', importIdentifier, t.callExpression(t.identifier("__replerRequire"), [t.stringLiteral(moduleName), t.identifier('module')])))
    ].concat(
        bindingList.map(([bindingName, iname]) => t.expressionStatement(t.assignmentExpression('=', t.identifier(bindingName), t.memberExpression(importIdentifier, t.identifier(iname)))))
    );

    return exprs;
}

function secretSauce() {
    return {
        visitor: {
            ImportDeclaration(babelPath) {
                const importPath = babelPath.node.source.value;

                if (importPath.substr(0, 2) === './' || importPath.substr(0, 3) === '../') {
                    let filePath = importPath;
                    let bindingList = new Map();
                    try {
                        filePath = vm.runInThisContext(`require.resolve("${importPath}")`);
                        if (!replBindingList.has(filePath)) {
                            bindingList = new Map();
                            replBindingList.set(filePath, bindingList);
                        } else {
                            bindingList = replBindingList.get(filePath);
                        }
                    } catch (e) {
                        return;
                    }

                    const importList = [];
                    const defaultImport = babelPath.node.specifiers.find(x => t.isImportDefaultSpecifier(x));
                    if (defaultImport) {
                        importList.push([defaultImport.local.name, 'default']);
                    }
                    babelPath.node.specifiers.filter(x => t.isImportSpecifier(x)).forEach(x => importList.push([x.local.name, x.imported.name]));

                    importList.forEach(([bindingName, name]) => bindingList.set(bindingName, name));
                    babelPath.replaceWithMultiple(createBindingExpression(filePath, importList));

                    // TODO only watch file if it's a top level import, and figure out the dependency chain
                    if (filePath !== null && !watchedFiles.has(filePath)) {
                        watcher.add(filePath);
                        watchedFiles.set(filePath, false);
                    }
                }
            }
        },
    };
}

async function init() {
    let packageJson = null;
    for (let directory = cwd; directory != '/'; directory = path.dirname(directory)) {
        if (await fsExtra.pathExists(path.join(directory, 'package.json'))) {
            packageJson = path.join(directory, 'package.json');
            break;
        }
    }

    if (packageJson === null) {
        console.log(chalk.red(`${cwd} isn't inside an NPM project`));
        process.exit(1);
    }

    const pkg = await fsExtra.readJSON(packageJson);
    let babelOpts = {};
    if (pkg.babel) {
        babelOpts = pkg.babel;
    } else if (await fsExtra.pathExists(path.join(path.dirname(packageJson), '.babelrc'))) {
        babelOpts = await fsExtra.readJSON(path.join(path.dirname(packageJson), '.babelrc'));
    }

    if (!babelOpts.plugins)
        babelOpts.plugins = [secretSauce];
    else
        babelOpts.plugins.push(secretSauce);

    // TODO add .compile command to output babel output
    const replInstance = repl.start({
        prompt: "> ",
        input: process.stdin, // TODO intercept stdin and listen for Ctrl-R for backwards search
        output: process.stdout,
        eval: replEval,
        useGlobal: true
    });

    replInstance.context.__replerRequire = function(modulePath, callingModule) {
        if (watchedFiles.get(modulePath, false) || !require.cache[modulePath]) {
            watchedFiles.set(modulePath, false);
            delete require.cache[modulePath];

            const script = fs.readFileSync(modulePath, 'utf-8');
            const transformed = compile(script, modulePath);

            const newModule = new Module(modulePath, callingModule);
            newModule.paths = require.resolve.paths(modulePath);
            newModule._compile(transformed.code, modulePath);
            newModule.filename = modulePath;
            require.cache[modulePath] = newModule;
        }

        const module = require(modulePath);
        if (module && module.__esModule) {
            return module;
        } else {
            return { default: module };
        }
    }

    replInstance.on('exit', () => watcher.close());
    replInstance.on('reset', () => {
        watchedFiles.forEach((_, path) => watcher.unwatch(path));
        watchedFiles.clear();
    });

    function compile(code, filename) {
        return babel.transform(code, {
            filename,
            presets: babelOpts.presets,
            plugins: babelOpts.plugins
        });
    }

    function replEval(code, context, filename, callback) {
        let result;
        try {
            const transformed = compile(code, filename);
            result = vm.runInThisContext(transformed.code, { filename });
        } catch (e) {
            return callback(e);
        }

        callback(undefined, result);
    }

    function logMessage(...args) {
        console.log();
        console.log(...args);
        replInstance.displayPrompt(true);
    }

    watcher
        .on('change', filePath => {
            // When a file changes reload the associated bindings in the REPL,
            // TODO proper dependency tree analysis

            const absPath = path.resolve(filePath);
            watchedFiles.set(absPath, true);
            const bindings = Array.from(replBindingList.get(absPath).entries());
            const ast = t.program(createBindingExpression(absPath, Array.from(replBindingList.get(absPath).entries())), [], "module");

            let source;
            if (bindings.length == 0) {
                source = `import "${filePath}";`
            } else {
                source = `import {\n${bindings.map(([name, imprt]) => imprt === name ? `    ${name}` : `    ${imprt} as ${name}`).join(',\n')}\n} from "${filePath}";`
            }

            const transformed = babel.transformFromAst(ast, null, babelOpts).code;
            vm.runInThisContext(transformed);
            logMessage(chalk.green(`${filePath} reloaded\n${source}`));
        })
        .on('unlink', filePath => {
            watcher.unwatch(filePath);
            watchedFiles.delete(path.resolve(filePath));
            logMessage(chalk.yellow(`${filePath} was removed`));
        })
        .on('error', error => {
            console.error(chalk.red(`Watcher error: ${error}`));
            process.exit(2);
        });
}

init();
