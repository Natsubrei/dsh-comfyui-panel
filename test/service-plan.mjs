/**
 * Pure decisions in the process manager: which interpreter to spawn, whether a
 * pid's working directory is the checkout, and whether the reported frontend
 * is the one this panel was verified against.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  VERIFIED_FRONTEND,
  adoptDirectory,
  checkoutMatches,
  comfyCliConfigPath,
  comfyCliDefaultInstall,
  comfyCliWorkspaces,
  cwdFromLsof,
  discoverComfyUi,
  frontendReport,
  installedFrontendVersion,
  pythonCommand,
} from '../service.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-comfyui-plan-'))
try {
  const unix = pythonCommand(root, {
    exists: path => path === join(root, '.venv', 'bin', 'python'),
    platform: 'linux',
  })
  assert.equal(unix, join(root, '.venv', 'bin', 'python'))
  assert.equal(pythonCommand(root, { exists: () => false, platform: 'linux' }), 'python3')

  const win = pythonCommand(root, {
    exists: path => path === join(root, '.venv', 'Scripts', 'python.exe'),
    platform: 'win32',
  })
  assert.equal(win, join(root, '.venv', 'Scripts', 'python.exe'))
  assert.equal(pythonCommand(root, { exists: () => false, platform: 'win32' }), 'python')

  assert.equal(cwdFromLsof('p4242\nfcwd\nn/opt/ComfyUI\n'), '/opt/ComfyUI')
  assert.equal(cwdFromLsof(''), null)
  assert.equal(cwdFromLsof('p1\n'), null)

  assert.equal(checkoutMatches(root, root), true)
  assert.equal(checkoutMatches(null, root), false)
  assert.equal(checkoutMatches('/no/such/checkout', root), false)

  assert.equal(installedFrontendVersion(null), null)
  assert.equal(installedFrontendVersion({ system: { comfyui_version: '0.3.0' } }), null)
  assert.equal(installedFrontendVersion({
    system: { comfyui_frontend_version: 'abc123def' },
  }), null, 'a commit hash is not a frontend version')
  assert.equal(installedFrontendVersion({
    system: {
      comfy_package_versions: [
        { name: 'comfyui-frontend-package', installed: '1.57.1', required: '1.57.1' },
      ],
    },
  }), '1.57.1')

  const match = frontendReport({
    system: {
      comfy_package_versions: [
        { name: 'comfyui-frontend-package', installed: VERIFIED_FRONTEND },
      ],
    },
  })
  assert.equal(match.status, 'verified')
  assert.equal(match.warning, null)

  const mismatch = frontendReport({
    system: { comfyui_frontend_version: '1.60.0' },
  })
  assert.equal(mismatch.status, 'mismatch')
  assert.equal(mismatch.installed, '1.60.0')
  assert.equal(mismatch.expected, VERIFIED_FRONTEND)
  assert.match(mismatch.warning ?? '', /1\.60\.0/)

  const omitted = frontendReport({ system: { comfyui_version: '0.3.0' } })
  assert.equal(omitted.status, 'unreported')
  assert.equal(omitted.warning, null)

  assert.equal(adoptDirectory('/opt/ComfyUI', '/elsewhere'), '/opt/ComfyUI')
  assert.equal(adoptDirectory(null, '/opt/ComfyUI'), '/opt/ComfyUI')
  assert.equal(adoptDirectory(null, null), null)

  // comfy-cli's own locations, not a list this plugin guessed.
  assert.equal(comfyCliConfigPath('/srv/user', 'linux'), '/srv/user/.config/comfy-cli/config.ini')
  assert.equal(comfyCliConfigPath('/srv/user', 'darwin'), '/srv/user/Library/Application Support/comfy-cli/config.ini')
  assert.equal(comfyCliConfigPath('C:\\data', 'win32'), 'C:\\data/AppData/Local/comfy-cli/config.ini')
  assert.equal(comfyCliDefaultInstall('/srv/user', 'linux'), '/srv/user/comfy/ComfyUI')
  assert.equal(comfyCliDefaultInstall('/srv/user', 'darwin'), '/srv/user/Documents/comfy/ComfyUI')

  // default_workspace leads, recent follows, blanks and junk are dropped.
  assert.deepEqual(
    comfyCliWorkspaces('[DEFAULT]\ndefault_workspace = /opt/ComfyUI\nrecent_workspace = /tmp/old\n# note\n'),
    ['/opt/ComfyUI', '/tmp/old'],
  )
  assert.deepEqual(comfyCliWorkspaces('recent_workspace = /tmp/old\ndefault_workspace = \n'), ['/tmp/old'])
  assert.deepEqual(comfyCliWorkspaces('not a config'), [])

  // An explicit env wins over a recorded workspace, which wins over the
  // default install. A relative ini value is ignored: it would resolve
  // against whichever directory the Host happened to start in.
  const discover = (extra = {}) => discoverComfyUi({
    env: {},
    home: '/srv/user',
    platform: 'linux',
    isCheckout: path => path === '/opt/ComfyUI' || path === '/env/ComfyUI',
    readText: () => 'default_workspace = /opt/ComfyUI\nrecent_workspace = /tmp/old\n',
    ...extra,
  })
  assert.equal(discover().cwd, '/opt/ComfyUI')
  assert.equal(discover({ env: { COMFYUI_HOME: '/env/ComfyUI' } }).cwd, '/env/ComfyUI')
  const fallback = discover({ readText: () => '', isCheckout: path => path === '/srv/user/comfy/ComfyUI' })
  assert.equal(fallback.cwd, '/srv/user/comfy/ComfyUI')
  const none = discover({ readText: () => 'default_workspace = relative/ComfyUI\n', isCheckout: () => false })
  assert.equal(none.cwd, null)
  assert.ok(!none.candidates.some(path => path.endsWith('/workspace/ComfyUI')), 'no private candidate list')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('service plan test passed')
