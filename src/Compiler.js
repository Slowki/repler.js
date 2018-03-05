// @flow
import REPL from './REPL';

export type CompileResult = {|
    code: string;
    sourceMap: any;
|}

/**
 * @abstract
 */
export default class Compiler {
    importIdentifierFromModulePath(filePath : string) : string {
        return '__repler_resolve_' + filePath.replace(/[\/\.-]/g, '_');
    }

    compile(repl : ?REPL, code: string, context: ?vm$Context, filename : string) : CompileResult {
        throw new Error('Not Implemented');
    }
}
