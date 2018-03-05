#!/usr/bin/env node
// @flow
import { REPL, BabelCompiler } from './index';

import chalk from 'chalk';
import fsExtra from 'fs-extra';
import yargs from 'yargs';

import path from 'path';
import fs from 'fs';
import repl from 'repl';

const argv = yargs
    .usage('Usage: $0')
    .version()
    .help('h')
    .alias('v', 'version')
    .alias('h', 'help')
    .argv;

async function init() {
    const cwd = process.cwd();
    let packageJson = null;
    for (let directory = cwd; directory != '/'; directory = path.dirname(directory)) {
        if (await fsExtra.pathExists(path.join(directory, 'package.json'))) {
            packageJson = path.join(directory, 'package.json');
            break;
        }
    }

    if (packageJson === null) {
        console.log(chalk.red(`${cwd} isn't inside an NPM project`));
        return process.exit(1);
    }

    const pkg : Object = await fsExtra.readJSON(packageJson);
    let babelOpts = {};
    if (pkg.babel) {
        babelOpts = pkg.babel;
    } else if (await fsExtra.pathExists(path.join(path.dirname(packageJson), '.babelrc'))) {
        babelOpts = await fsExtra.readJSON(path.join(path.dirname(packageJson), '.babelrc'));
    }

    if (!babelOpts.plugins)
        babelOpts.plugins = [];

    const babelCompiler = new BabelCompiler(babelOpts);

    // TODO add .compile command to output babel output
    // TODO add .docs command to search for doc strings
    const replInstance = new REPL({
        compiler: babelCompiler,
        // input: process.stdin, // TODO intercept stdin and listen for Ctrl-R for backwards search
        ignoreUndefined: true,
        useGlobal: true,
        replMode: repl.REPL_MODE_SLOPPY
    });
}

init();
