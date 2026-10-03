"""MODEP stock UI preservation and the additive Grid backend contract."""
import io
import json
import os
import re
import tempfile
from unittest.mock import patch

from base import ModUITestCase


class TestModepGridIntegration(ModUITestCase):
    __test__ = True

    def test_stock_keeps_blokas_ui_patchstorage_and_grid_navigation(self):
        response = self.fetch('/index.html?v=1')
        self.assertEqual(response.code, 200)
        body = response.body.decode()
        for marker in ('<title>Pedalboard</title>', 'id="patchstorage-library"',
                       'id="blokas-update"', 'js/patchstorage.js', 'id="mod-grid-theme"',
                       'do_blokas_update(true)', 'moddevices.com', 'apple-mobile-web-app-capable'):
            self.assertIn(marker, body)
        self.assertIn("$('#mod-cloud-plugins').hide()", body)
        self.assertIn("$('#mod-settings').hide()", body)

    def test_grid_bootstrap_and_every_local_script_and_stylesheet_exist(self):
        response = self.fetch('/grid.html?v=1')
        self.assertEqual(response.code, 200)
        body = response.body.decode()
        self.assertIn('<title>MODEP Grid</title>', body)
        for name in ('PATCHSTORAGE_TARGET_ID', 'TONE3000_CLIENT_ID', 'BUFFER_SIZE'):
            self.assertIn(name, body)
        self.assertNotIn('{{patchstorage_', body)
        self.assertNotIn('{{tone3000_', body)
        self.assertNotIn('{{bufferSize}}', body)
        for asset in re.findall(r'(?:src|href)="((?:js|css|resources)/[^"?]+)', body):
            self.assertEqual(self.fetch('/' + asset).code, 200, asset)
        self.assertIn('grid-settings-classic-ui', body)

    def test_oauth_popup_pages_render(self):
        for page in ('tone3000-connect.html', 'tone3000-callback.html'):
            self.assertEqual(self.fetch('/' + page + '?v=1').code, 200)

    def test_profiler_format_remains_available_next_to_new_nam_format(self):
        from mod.webserver import FilesList
        self.assertEqual(FilesList._get_dir_and_extensions_for_filetype('tapf'),
                         ('Amplifier Profiles', ('.tapf',)))
        self.assertEqual(FilesList._get_dir_and_extensions_for_filetype('nammodel'),
                         ('NAM Models', ('.nam',)))

    def test_current_pedalboard_and_snapshot_endpoints(self):
        from mod.webserver import SESSION
        SESSION.host.pedalboard_path = '/tmp/example.pedalboard'
        SESSION.host.pedalboard_snapshots[0]['name'] = 'Clean'
        self.assertEqual(self.fetch('/pedalboard/current').body, b'/tmp/example.pedalboard')
        self.assertEqual(self.fetch('/snapshot/current').body, b'Clean')

    def test_both_stock_and_grid_install_urls_forward_store_identity(self):
        for url in ('/effect/install', '/effect/install/'):
            with patch('mod.webserver.install_package') as install:
                def finish(filename, callback, options):
                    self.assertEqual(options, {'psid': '123', 'psversion': '2.1'})
                    os.remove(filename)
                    callback({'ok': True, 'installed': ['urn:test'], 'removed': []})
                install.side_effect = finish
                response = self.fetch(url, method='POST', body=b'package', headers={
                    'Content-Type': 'application/octet-stream',
                    'Patchstorage-Item': '123', 'Patchstorage-Item-Version': '2.1'})
                self.assertEqual(response.code, 200)
                self.assertTrue(json.loads(response.body)['result']['ok'])

    def test_blokas_version_check_retains_versions_and_exposes_upgrade_guard(self):
        with patch('mod.webserver.subprocess.Popen') as process, \
             patch('mod.webserver.urllib.request.urlopen') as download:
            process.return_value.stdout = io.StringIO('Package: modep-mod-ui\nVersion: 1.13\n')
            download.return_value.read.return_value = b'{"latest":"1.14"}'
            response = self.fetch('/apt/check')
            payload = json.loads(response.body)
            self.assertEqual(payload['current'], '1.13')
            self.assertEqual(payload['latest'], '1.14')
            self.assertTrue(payload['custom_build'])
            self.assertFalse(payload['upgrade_allowed'])

    def test_official_update_cannot_replace_grid_without_explicit_configuration(self):
        with patch('mod.webserver.subprocess.Popen') as process, \
             patch('mod.webserver.time.sleep') as sleep, patch('builtins.open') as opened:
            response = self.fetch('/apt/upgrade')
            self.assertEqual(response.code, 409)
            self.assertIn('custom Grid build', json.loads(response.body)['message'])
            process.assert_not_called()
            sleep.assert_not_called()
            opened.assert_not_called()

    def test_snapshot_changes_are_written_to_the_existing_board(self):
        from mod.webserver import SESSION
        with tempfile.TemporaryDirectory(prefix='modui-grid-snapshots-') as folder:
            SESSION.host.pedalboard_path = folder
            response = self.fetch('/snapshot/saveas?title=Crunch')
            self.assertTrue(json.loads(response.body)['ok'])
            with open(os.path.join(folder, 'snapshots.json')) as handle:
                data = json.load(handle)
            self.assertEqual(data['snapshots'][data['current']]['name'], 'Crunch')
            self.assertEqual(self.fetch('/snapshot/save', method='POST', body=b'').body, b'true')

    def test_modep_entrypoint_import_does_not_start_the_server(self):
        with patch('mod.webserver.run') as start:
            from mod.modep import run
            self.assertTrue(callable(run))
            start.assert_not_called()

    def test_pedalboard_thumbnail_works_with_current_pillow(self):
        from PIL import Image
        from modtools.pedalboard import resize_image
        image = Image.new('RGB', (1280, 960))
        resize_image(image)
        self.assertEqual(image.size, (640, 480))
