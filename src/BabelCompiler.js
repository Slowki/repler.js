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
                            // TODO improve
                            filePath = vm.runInThisContext(`require.resolve("${importPath}")`);
                        } catch (e) {
                            return;
                        }

                        const importList = [];
                        const defaultImport = babelPath.node.specifiers.find(x => t.isImportDefaultSpecifier(x));
                        if (defaultImport) {
                            importList.push([defaultImport.local.name, 'default']);
                        }

                        const namespaceImport = babelPath.node.specifiers.find(x => t.isImportNamespaceSpecifier(x));
                        if (namespaceImport) {
                            importList.push([namespaceImport.local.name, '*']);
                        }

                        babelPath.node.specifiers.filter(x => t.isImportSpecifier(x)).forEach(x => importList.push([x.local.name, x.imported.name]));

                        const importIdentifierName = compiler.importIdentifierFromModulePath(filePath);
                        const importIdentifier = t.identifier(importIdentifierName);

                        const statements = [
                            t.variableDeclaration('let', [t.variableDeclarator(importIdentifier, t.callExpression(t.identifier("__replerRequire"), [t.stringLiteral(filePath), t.identifier('module')]))])
                        ];

                        if (importList.length > 0) {
                            statements.push(
                                t.variableDeclaration('let', importList.map(([bindingName, iname]) => {
                                    if (iname !== '*')
                                        return t.variableDeclarator(t.identifier(bindingName), t.memberExpression(importIdentifier, t.identifier(iname)));
                                    else
                                        return t.variableDeclarator(t.identifier(bindingName), importIdentifier);
                                }))
                            );
                        }

                        babelPath.replaceWithMultiple(statements);

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
                },

                Program(babelPath) {
                    // Prevent that annoying "use-strict" print
                    if (!babelPath.get('body').some(x => x.isExpressionStatement()))
                        babelPath.pushContainer('body', t.expressionStatement(t.identifier('undefined')));
                }
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
        const transformed = babel.transform(code, {
            filename,
            sourceMaps: true,
            presets: this.babelOpts.presets,
            plugins: this.babelOpts.plugins.concat(replerPlugin(this, repl))
        });

        return {
            code: transformed.code,
            sourceMap: transformed.map
        };
    }
}
