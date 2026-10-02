"""MODEP API compatibility and complete Grid template bootstrap."""

from base import ModUITestCase
import json
import tempfile
from unittest.mock import patch


class TestRaspberryIntegration(ModUITestCase):
    __test__ = True

    def test_grid_renders_store_and_tone_bootstrap_without_device_credentials(self):
        from mod import settings
        response = self.fetch('/grid.html?v=1')
        self.assertEqual(response.code, 200)
        body = response.body.decode('utf-8')
        self.assertIn("PATCHSTORAGE_PLATFORM_ID = '%s'" % settings.PATCHSTORAGE_PLATFORM_ID, body)
        self.assertIn("PATCHSTORAGE_TARGET_ID = '%s'" % settings.PATCHSTORAGE_TARGET_ID, body)
        self.assertIn('grid-params.js', body)
        self.assertIn('grid-store.js', body)
        self.assertIn('grid-tone3000.js', body)
        self.assertNotIn('{{patchstorage_', body)

    def test_external_tools_can_read_current_pedalboard_and_snapshot(self):
        from mod.webserver import SESSION
        SESSION.host.pedalboard_path = '/tmp/board with spaces.pedalboard'
        SESSION.host.pedalboard_snapshots[0]['name'] = 'Mic + Guitar'
        self.assertEqual(self.fetch('/pedalboard/current').body,
                         b'/tmp/board with spaces.pedalboard')
        self.assertEqual(self.fetch('/snapshot/current').body, b'Mic + Guitar')

    def test_empty_session_has_default_snapshot_and_no_current_path(self):
        self.assertEqual(self.fetch('/pedalboard/current').body, b'')
        self.assertEqual(self.fetch('/snapshot/current').body, b'Default')

    def test_plugin_upload_forwards_patchstorage_identity_and_keeps_response_contract(self):
        from mod import webserver
        received = []

        def install(filename, callback, options):
            with open(filename, 'rb') as handle:
                received.append((handle.read(), options))
            callback({'ok': True, 'installed': ['urn:test'], 'removed': []})

        with tempfile.TemporaryDirectory(prefix='modui-upload-test-') as root, \
                patch.object(webserver, 'DOWNLOAD_TMP_DIR', root), \
                patch.object(webserver.EffectInstaller, 'destination_dir', root), \
                patch.object(webserver, 'install_package', install):
            response = self.fetch('/effect/install/', method='POST', body=b'fake archive',
                                  headers={'Content-Type': 'application/octet-stream',
                                           'Patchstorage-Item': '123',
                                           'Patchstorage-Item-Version': '2.1'})
        self.assertEqual(response.code, 200)
        self.assertEqual(received, [(b'fake archive', {'psid': '123', 'psversion': '2.1'})])
        self.assertEqual(json.loads(response.body)['result']['installed'], ['urn:test'])
