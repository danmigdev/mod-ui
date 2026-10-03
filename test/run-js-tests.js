'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function testFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const filename = path.join(dir, entry.name)
        return entry.isDirectory() ? testFiles(filename)
            : entry.name.endsWith('.test.js') ? [filename] : []
    }).sort()
}

const result = spawnSync(process.execPath,
    ['--test', ...process.argv.slice(2), ...testFiles(path.join(__dirname, 'js'))],
    { stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status === null ? 1 : result.status)
