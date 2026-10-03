#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Check real Lilv metadata in a subprocess with exactly one world init."""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest


@unittest.skipUnless(sys.platform.startswith('linux'), 'Requires the Linux native library')
class TestPatchstorageNativeMetadata(unittest.TestCase):
    def test_store_identity_refreshes_without_changing_local_plugin_shape(self):
        repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        library = os.path.join(repo_root, 'utils', 'libmod_utils.so')
        if not os.path.isfile(library):
            self.skipTest('Build libmod_utils.so before running native metadata tests')

        root = tempfile.mkdtemp(prefix='modui-patchstorage-native-')
        try:
            bundle = os.path.join(root, 'bundle with spaces.lv2')
            shutil.copytree(os.path.join(repo_root, 'test', 'fixtures', 'phase6-fixture.lv2'), bundle)
            turtle = os.path.join(bundle, 'phase6-fixture.ttl')
            with open(turtle, 'a') as handle:
                handle.write("""
@prefix pg: <http://lv2plug.in/ns/ext/port-groups#> .
<urn:test:tone> a pg:InputGroup ; lv2:name "Tone" ; lv2:symbol "tone" ; lv2:index 20 .
<http://example.org/plugins/phase6-fixture> lv2:port [
    a lv2:InputPort, lv2:ControlPort ; lv2:index 2 ; lv2:symbol "gain" ;
    lv2:name "Gain" ; lv2:minimum 0 ; lv2:maximum 1 ; lv2:default 0.5 ;
    pg:group <urn:test:tone>
] .
""")
            environment = dict(os.environ)
            environment['LV2_PATH'] = root
            environment['MOD_PATCHSTORAGE_TEST_BUNDLE'] = bundle
            # Use an isolated process because the Lilv namespace singleton may
            # not be initialized twice in the characterization test process.
            script = '''
import os
from mod.patchstorage import write_install_metadata
from modtools import utils

bundle = os.environ['MOD_PATCHSTORAGE_TEST_BUNDLE']
uri = 'http://example.org/plugins/phase6-fixture'
assert utils._native_plugin_bundle_path(uri.encode('utf-8')) is None
utils.init()
path = utils._native_plugin_bundle_path(uri.encode('utf-8')).decode('utf-8')
assert os.path.realpath(path) == os.path.realpath(bundle)
assert utils._native_plugin_bundle_path(b'urn:missing:plugin') is None

def listed():
    return next(plugin for plugin in utils.get_all_plugins() if plugin['uri'] == uri)

original_mini = listed()
original_full = utils.get_plugin_info(uri)
assert original_full['portGroups'] == [{'valid': True, 'uri': 'urn:test:tone', 'symbol': 'tone', 'name': 'Tone', 'index': 20}], repr(original_full['portGroups'])
assert original_full['ports']['control']['input'][0]['group'] == 'urn:test:tone'
assert 'patchstorage' not in original_mini
assert 'patchstorage' not in original_full
write_install_metadata(os.path.dirname(bundle), {'psid': 123, 'psversion': '1.0'})
assert listed()['patchstorage'] == {'id': 123, 'revision': '1.0'}
assert utils.get_plugin_info(uri)['patchstorage'] == {'id': 123, 'revision': '1.0'}
native_lookup = utils._native_plugin_bundle_path
utils._native_plugin_bundle_path = None
assert listed()['patchstorage'] == {'id': 123, 'revision': '1.0'}
assert utils.get_plugin_info(uri)['patchstorage'] == {'id': 123, 'revision': '1.0'}
utils._native_plugin_bundle_path = native_lookup
write_install_metadata(os.path.dirname(bundle), {'psid': 123, 'psversion': '1.1'})
assert listed()['patchstorage']['revision'] == '1.1'
assert utils.get_plugin_info(uri)['patchstorage']['revision'] == '1.1'
os.unlink(os.path.join(bundle, 'patchstorage.json'))
assert listed() == original_mini
assert utils.get_plugin_info(uri) == original_full

with open(os.path.join(bundle, 'patchstorage.json'), 'w') as handle:
    handle.write('invalid json')
assert 'patchstorage' not in listed()
assert 'patchstorage' not in utils.get_plugin_info(uri)
print('Native bundle lookup, store revisions and unchanged local payloads verified')
'''
            process = subprocess.Popen([sys.executable, '-c', script], cwd=repo_root,
                                       env=environment, stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE)
            stdout, stderr = process.communicate(timeout=30)
            self.assertEqual(process.returncode, 0, (stdout + stderr).decode('utf-8', errors='replace'))
        finally:
            shutil.rmtree(root)


if __name__ == '__main__':
    unittest.main()
