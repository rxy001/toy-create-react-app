const program = require('commander')
const packageJson = require('./package.json')
const chalk = require('chalk')
const path = require('path')
const validateProjectName = require('validate-npm-package-name')
const fs = require('fs-extra')
let { execSync } = require('child_process')
const semver = require('semver')
const dns = require('dns')
const os = require('os')

// child_process.spawn  yarn add 总是报错 “spawn yarn enoent ”
const spawn = require('cross-spawn')

const errorLogFilePatterns = [
  'npm-debug.log',
  'yarn-error.log',
  'yarn-debug.log'
]

let projectName
program
  .version(packageJson.version, '-v --version')
  .arguments('<project-directory')
  .usage(`${chalk.green('<project-directory>')} [options]`)
  .action(function(name) {
    projectName = name
  })
  .option('--use-npm')
  .option('--use-yarn')
  .parse(process.argv)

if (typeof projectName === 'undefined') {
  console.error('Please specify the project directory:')
  console.log(
    `  ${chalk.cyan(packageJson.name)} ${chalk.green('<project-directory>')}`
  )
  process.exit(1)
}

createApp(projectName, program.useNpm)

function createApp(name, useNpm) {
  const root = path.resolve(name)
  const appName = path.basename(root)
  checkName(appName)
  fs.ensureDirSync(name)
  if (!isSafeToCreateProjectIn(root, name)) {
    process.exit(1)
  }

  const packageJson = {
    name: appName,
    version: '0.1.0',
    private: true
  }
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(packageJson, null, 2) + os.EOL
  )

  const useYarn = useNpm ? false : shouldUseYarn()
  const originalDirectory = process.cwd()
  process.chdir(root)
  if (!useYarn && !checkThatNpmCanReadCwd()) {
    process.exit(1)
  }

  if (!useYarn) {
    const npmInfo = checkNpmVersion()
    if (npmInfo.hasMinNpm) {
      if (npmInfo.npmVersion) {
        console.log(
          chalk.red(
            `You are using npm ${npmInfo.npmVersion}` +
              `Please update to npm 5 or higher for a better.\n`
          )
        )
      }
      process.exit(1)
    }
  } else {
    let yarnUsesDefaultRegistry = true
    try {
      yarnUsesDefaultRegistry =
        execSync('yarn config get registry')
          .toString()
          .trim() === 'https://registry.yarnpkg.com'
    } catch (error) {}
    if (yarnUsesDefaultRegistry) {
      fs.copySync(
        require.resolve('./yarn.lock.cached'),
        path.join(root, 'yarn.lock')
      )
    }
  }

  run(useYarn, root, appName, originalDirectory)
}

function run(useYarn, root, appName, originalDirectory) {
  const allDependencies = ['react', 'react-dom', 'react-scripts']
  console.log('Installing packages. This might take a couple of minutes.')

  checkIfOnline(useYarn)
    .then(isOnline => {
      console.log(
        `Installing ${chalk.cyan('react')}, ${chalk.cyan(
          'react-dom'
        )}, and ${chalk.cyan('react-scripts')}...`
      )

      return install(allDependencies, useYarn, isOnline)
    })
    .then(async () => {
      setCaretRangeForRuntimeDeps()
      await executeNodeScript(
        {
          cwd: process.cwd(),
          args: []
        },
        [root, appName, originalDirectory],
        `
          var init = require('react-scripts/scripts/init.js');
          init.apply(null, JSON.parse(process.argv[1]));
        `
      )
    })
    .catch(reason => {
      console.log()
      console.log('Aborting installation.')
      if (reason.command) {
        console.log(`  ${chalk.cyan(reason.command)} has failed.`)
      } else {
        console.log(chalk.red('Unexpected error. Please report it as a bug:'))
        console.log(reason)
      }

      // On 'exit' we will delete these files from target directory.
      const knownGeneratedFiles = ['package.json', 'yarn.lock', 'node_modules']
      const currentFiles = fs.readdirSync(path.join(root))
      currentFiles.forEach(file => {
        knownGeneratedFiles.forEach(fileToMatch => {
          // This removes all knownGeneratedFiles.
          if (file === fileToMatch) {
            console.log(`Deleting generated file... ${chalk.cyan(file)}`)
            fs.removeSync(path.join(root, file))
          }
        })
      })
      const remainingFiles = fs.readdirSync(path.join(root))
      if (!remainingFiles.length) {
        // Delete target folder if empty
        console.log(
          `Deleting ${chalk.cyan(`${appName}/`)} from ${chalk.cyan(
            path.resolve(root, '..')
          )}`
        )
        process.chdir(path.resolve(root, '..'))
        fs.removeSync(path.join(root))
      }
      console.log('Done.')
      process.exit(1)
    })
}

function checkName(appName) {
  const validationResult = validateProjectName(appName)
  if (!validationResult.validForNewPackages) {
    console.error(
      `Could not create a project called ${chalk.red(
        `"${appName}"`
      )} because of npm naming restrictions:`
    )
    printValidationResults(validationResult.errors)
    printValidationResults(validationResult.warnings)
    process.exit(1)
  }
  const dependencies = ['react', 'react-dom', 'react-scripts']
  if (dependencies.includes(appName)) {
    console.error(
      chalk.red(
        `We cannot create a project called ${chalk.green(
          appName
        )} because a dependency with the same name exists.\n` +
          `Due to the way npm works, the following names are not allowed:\n\n`
      ) +
        chalk.cyan(dependencies.map(depName => `  ${depName}`).join('\n')) +
        chalk.red('\n\nPlease choose a different project name.')
    )
    process.exit(1)
  }
}

function printValidationResults(result) {
  if (!result) {
    return
  }
  info.forEach(function(error) {
    console.log(chalk.red(`  *  ${error}`))
  })
}

function isSafeToCreateProjectIn(root, name) {
  const validFiles = [
    '.DS_Store',
    'Thumbs.db',
    '.git',
    '.gitignore',
    '.idea',
    'README.md',
    'LICENSE',
    '.hg',
    '.hgignore',
    '.hgcheck',
    '.npmignore',
    'mkdocs.yml',
    'docs',
    '.travis.yml',
    '.gitlab-ci.yml',
    '.gitattributes'
  ]

  const currentFiles = fs.readdirSync(path.join(root))

  const conflicts = currentFiles
    .filter(file => !validFiles.includes(file))
    .filter(file => !/\.iml$/.test(file))
    .filter(file => !errorLogFilePatterns.includes(file))

  if (conflicts.length) {
    console.log(
      `The directory ${chalk.green(name)} contains files that could conflict:`
    )
    console.log()
    for (const file of conflicts) {
      console.log(`  ${file}`)
    }
    console.log()
    console.log(
      'Either try using a new directory name, or remove the files listed above.'
    )

    return false
  }

  currentFiles.forEach(file => {
    errorLogFilePatterns.includes(file) && fs.removeSync(path.join(root, file))
  })
  return true
}

function shouldUseYarn() {
  try {
    execSync('yarn -v', { stdio: 'ignore' })
    return true
  } catch (error) {
    return false
  }
}

function checkThatNpmCanReadCwd() {
  const cwd = process.cwd()
  let childOutput = null
  try {
    // Note: intentionally using spawn over exec since
    // the problem doesn't reproduce otherwise.
    // `npm config list` is the only reliable way I could find
    // to reproduce the wrong path. Just printing process.cwd()
    // in a Node process was not enough.
    childOutput = spawn.sync('npm', ['config', 'list']).output.join('')
  } catch (err) {
    // Something went wrong spawning node.
    // Not great, but it means we can't do this check.
    // We might fail later on, but let's continue.
    return true
  }
  if (typeof childOutput !== 'string') {
    return true
  }
  const lines = childOutput.split('\n')
  // `npm config list` output includes the following line:
  // "; cwd = C:\path\to\current\dir" (unquoted)
  // I couldn't find an easier way to get it.
  const prefix = '; cwd = '
  const line = lines.find(line => line.indexOf(prefix) === 0)
  if (typeof line !== 'string') {
    // Fail gracefully. They could remove it.
    return true
  }
  const npmCWD = line.substring(prefix.length)
  if (npmCWD === cwd) {
    return true
  }
  console.error(
    chalk.red(
      `Could not start an npm process in the right directory.\n\n` +
        `The current directory is: ${chalk.bold(cwd)}\n` +
        `However, a newly started npm process runs in: ${chalk.bold(
          npmCWD
        )}\n\n` +
        `This is probably caused by a misconfigured system terminal shell.`
    )
  )
  if (process.platform === 'win32') {
    console.error(
      chalk.red(`On Windows, this can usually be fixed by running:\n\n`) +
        `  ${chalk.cyan(
          'reg'
        )} delete "HKCU\\Software\\Microsoft\\Command Processor" /v AutoRun /f\n` +
        `  ${chalk.cyan(
          'reg'
        )} delete "HKLM\\Software\\Microsoft\\Command Processor" /v AutoRun /f\n\n` +
        chalk.red(`Try to run the above two lines in the terminal.\n`) +
        chalk.red(
          `To learn more about this problem, read: https://blogs.msdn.microsoft.com/oldnewthing/20071121-00/?p=24433/`
        )
    )
  }
  return false
}

function checkNpmVersion() {
  let npmVersion = null
  let hasMinNpm = true
  try {
    npmVersion = execSync('npm -v')
      .toString()
      .trim()
    hasMinNpm = semver.lte(npmVersion, '5.0.0')
  } catch (error) {}
  return {
    npmVersion,
    hasMinNpm
  }
}

function checkIfOnline(useYarn) {
  if (!useYarn) {
    return true
  }
  return new Promise(resolve => {
    dns.lookup('registry.yarnpkg.com', err => {
      resolve(err == null ? true : false)
    })
  })
}

function install(allDependencies, useYarn, isOnline) {
  return new Promise((resolve, reject) => {
    let command, args
    if (useYarn) {
      command = 'yarn'
      args = ['add', '--exact']
      if (!isOnline) {
        args.push('--offline')
      }
      args = [...args, ...allDependencies]
    } else {
      command = 'npm'
      args = [
        'install',
        '--save',
        '--save-exact',
        '--loglevel',
        'error',
        ...dependencies
      ]
    }

    const child = spawn(command, args, { stdio: 'inherit' })
    child.on('close', code => {
      if (code !== 0) {
        reject({
          command: `${command} ${args.join(' ')}`
        })
        return
      }
      resolve()
    })

    child.on('error', err => {
      console.log(err)
    })
  })
}

function setCaretRangeForRuntimeDeps() {
  const packageName = 'react-scripts'
  const packagePath = path.join(process.cwd(), 'package.json')
  const packageJson = require(packagePath)

  if (typeof packageJson.dependencies === 'undefined') {
    console.error(chalk.red('Missing dependencies in package.json'))
    process.exit(1)
  }

  const packageVersion = packageJson.dependencies[packageName]
  if (typeof packageVersion === 'undefined') {
    console.error(chalk.red(`Unable to find ${packageName} in package.json`))
    process.exit(1)
  }

  makeCaretRange(packageJson.dependencies, 'react')
  makeCaretRange(packageJson.dependencies, 'react-dom')

  fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + os.EOL)
}

function makeCaretRange(dependencies, name) {
  const version = dependencies[name]

  if (typeof version === 'undefined') {
    console.error(chalk.red(`Missing ${name} dependency in package.json`))
    process.exit(1)
  }

  let patchedVersion = `^${version}`

  if (!semver.validRange(patchedVersion)) {
    console.error(
      `Unable to patch ${name} dependency version because version ${chalk.red(
        version
      )} will become invalid ${chalk.red(patchedVersion)}`
    )
    patchedVersion = version
  }

  dependencies[name] = patchedVersion
}

function executeNodeScript({ cwd, args }, data, source) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [...args, '-e', source, '--', JSON.stringify(data)],
      { cwd, stdio: 'inherit' }
    )

    child.on('close', code => {
      if (code !== 0) {
        reject({
          command: `node ${args.join(' ')}`
        })
        return
      }
      resolve()
    })
  })
}
