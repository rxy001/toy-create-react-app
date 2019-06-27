#!/usr/bin/env node

var chalk = require('chalk')
const semver = require('semver')

if (!semver.satisfies(process.version, '>=8.10.0')) {
  console.error(
    chalk.red(
      'You are running Node ' +
        currentNodeVersion +
        '.\n' +
        'Create React App requires Node 8.10.0 or higher. \n' +
        'Please update your version of Node.'
    )
  )
  process.exit(1)
}

require('./create-react-app')
