# Repler #

A hot reloading REPL with Babel support


## Usage - CLI ##
If you have it installed globally:

    repler # Start the repler REPL

If you want to install it inside the package you're in:

    npx repler # Download repler into node_modules and start the REPL
   
### How it Works ###
`repler` acts like a normal node REPL, with the exception that it supports Babel and automatically reloads files imported using ES2015 import syntax. So if you run something like `import * as foo from './bar'`, every time you change `./bar.js`, the file will be re-imported automagically.

### Example ##

    # inside repler shell
    # assuming we have a file called ./bar.js which contains `export default 1;`
    > import foo from './bar';
    > console.log(foo); // => 1
    # change `export default 1;` to `export default 2;`
    > console.log(foo); // => 2

## Features ##

* A drop-in replacement for the normal node REPL
* Support for Babel
* Automatic reloading when an imported file changes

## TODOs ##
* Source map support
* Pluggable compilers
* Documentation searching
* .compile command
* Better readline interface with features like Ctrl-R support
