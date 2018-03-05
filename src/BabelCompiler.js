// @flow
import Compiler, { type CompileResult } from './Compiler';
import REPL from './REPL';

import * as babel from 'babel-core';
import * as t from 'babel-types';

import vm from 'vm';

function replerPlugin(compiler : BabelCompiler, repl : ?REPL) {
    return function() {
        return {
            visitor: {
                ImportDeclaration(babelPath) {
                    const importPath = babelPath.node.source.value;

                    if (importPath.substr(0, 2) === './' || importPath.substr(0, 3) === '../') {
                        let filePath = importPath;
                        try {
                            filePath = vm.runInThisContext(`require.resolve("${importPath}")`);
                        } catch (e) {
                            return;
                        }

                        const importList = [];
                        const defaultImport = babelPath.node.specifiers.find(x => t.isImportDefaultSpecifier(x));
                        if (defaultImport) {
                            importList.push([defaultImport.local.name, 'default']);
                        }
                        babelPath.node.specifiers.filter(x => t.isImportSpecifier(x)).forEach(x => importList.push([x.local.name, x.imported.name]));

                        babelPath.replaceWithMultiple(compiler.createImportExpression(filePath, importList));

                        if (repl != null) {
                            let bindingList : Map<string, string> = new Map();
                            if (repl.replBindingList.has(filePath)) {
                                bindingList = (repl.replBindingList.get(filePath) : any);
                            } else {
                                repl.replBindingList.set(filePath, bindingList);
                            }
                            importList.forEach(([bindingName, name]) => bindingList.set(bindingName, name));
                        }
                    }
                }
                // TODO fix use strict thing
            },
        };
    }
}

export default class BabelCompiler extends Compiler {
    babelOpts : Object;

    constructor(babelOpts : Object) {
        super();
        // TODO look for env and set the node version to this node version to keep codegen clean
        this.babelOpts = babelOpts;
    }

    compile(repl : ?REPL, code: string, context: ?vm$Context, filename : string) : CompileResult {
        return babel.transform(code, {
            filename,
            presets: this.babelOpts.presets,
            plugins: this.babelOpts.plugins.concat(replerPlugin(this, repl))
        });
    }

    createImportExpression(moduleName : string, bindingList : [string, string][]) : mixed {
        const importIdentifierName = this.importIdentifierFromModulePath(moduleName);
        const importIdentifier = t.identifier(importIdentifierName);

        return [
            t.variableDeclaration('let', [t.variableDeclarator(importIdentifier, t.callExpression(t.identifier("__replerRequire"), [t.stringLiteral(moduleName), t.identifier('module')]))])
        ].concat(
            t.variableDeclaration('let', bindingList.map(([bindingName, iname]) => t.variableDeclarator(t.identifier(bindingName), t.memberExpression(importIdentifier, t.identifier(iname)))))
        );
    }
}
