#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Pure Python coverage for catalog ABI selection and install identity."""

import json
import os
import shutil
import tempfile
import unittest

from mod.patchstorage import (get_config, read_bundle_metadata, resolve_target,
                              validate_install_options, write_install_metadata)


class TestPatchstorageConfig(unittest.TestCase):
    def test_arm64_and_32_bit_userspace_on_64_bit_kernel(self):
        self.assertEqual(resolve_target({}, 'aarch64', 64), 8280)
        self.assertEqual(resolve_target({}, 'aarch64', 32), 8278)
        self.assertEqual(resolve_target({}, 'armv7l', 32), 8278)

    def test_explicit_modep_target_is_not_overwritten(self):
        environment = {'PATCHSTORAGE_TARGET_ID': '9999'}
        self.assertEqual(resolve_target(environment, 'aarch64', 64), 9999)
        environment['MOD_PATCHSTORAGE_TARGET_ID'] = '10000'
        self.assertEqual(resolve_target(environment, 'aarch64', 64), 10000)

    def test_architecture_overrides_remain_supported(self):
        environment = {'PATCHSTORAGE_ARMHF_TARGET_ID': '9001',
                       'PATCHSTORAGE_AARCH64_TARGET_ID': '9002'}
        self.assertEqual(resolve_target(environment, 'aarch64', 32), 9001)
        self.assertEqual(resolve_target(environment, 'aarch64', 64), 9002)

    def test_current_public_catalog_and_modep_proxy_override(self):
        config = get_config({}, 'aarch64', 64, True)
        self.assertTrue(config['enabled'])
        self.assertEqual(config['target_id'], 8280)
        self.assertEqual(config['platform_id'], 8046)
        self.assertEqual(config['api_url'], 'https://patchstorage.com/api/beta/patches')
        override = get_config({'PATCHSTORAGE_API_URL': 'http://localhost/api/beta/patches/',
                               'PATCHSTORAGE_PLATFORM_ID': '5027',
                               'PATCHSTORAGE_ENABLED': '0'}, 'aarch64', 64, True)
        self.assertFalse(override['enabled'])
        self.assertEqual(override['api_url'], 'http://localhost/api/beta/patches')
        self.assertEqual(override['platform_id'], 5027)

    def test_unknown_architecture_requires_a_target_to_enable_downloads(self):
        self.assertFalse(get_config({}, 'riscv64', 64, True)['enabled'])
        with self.assertRaises(ValueError):
            get_config({'PATCHSTORAGE_ENABLED': '1'}, 'riscv64', 64, True)
        explicit = get_config({'PATCHSTORAGE_ENABLED': '1',
                               'PATCHSTORAGE_TARGET_ID': '9000'}, 'riscv64', 64, True)
        self.assertTrue(explicit['enabled'])

    def test_non_linux_default_and_invalid_configuration(self):
        self.assertFalse(get_config({}, 'AMD64', 64, False)['enabled'])
        for environment in ({'PATCHSTORAGE_TARGET_ID': '0'},
                            {'PATCHSTORAGE_PLATFORM_ID': '-1'},
                            {'PATCHSTORAGE_ENABLED': 'maybe'},
                            {'PATCHSTORAGE_API_URL': 'file:///tmp/catalog'}):
            with self.assertRaises(ValueError):
                get_config(environment, 'aarch64', 64, True)


class TestPatchstorageMetadata(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='modui-patchstorage-')
        self.bundle = os.path.join(self.root, 'first.lv2')
        os.makedirs(self.bundle)
        with open(os.path.join(self.bundle, 'manifest.ttl'), 'w') as handle:
            handle.write('# Test bundle\n')

    def tearDown(self):
        shutil.rmtree(self.root)

    def test_install_records_every_bundle_and_preserves_revision(self):
        second = os.path.join(self.root, 'second.lv2')
        os.makedirs(second)
        with open(os.path.join(second, 'manifest.ttl'), 'w') as handle:
            handle.write('# Another bundle\n')
        metadata = write_install_metadata(self.root, {'psid': '195413', 'psversion': '1.2'})
        self.assertEqual(metadata, {'id': 195413, 'revision': '1.2'})
        self.assertEqual(read_bundle_metadata(self.bundle), metadata)
        self.assertEqual(read_bundle_metadata(second), metadata)
        write_install_metadata(self.root, {'psid': 195413, 'psversion': '1.3'})
        self.assertEqual(read_bundle_metadata(self.bundle)['revision'], '1.3')
        self.assertFalse(any(name.startswith('.patchstorage-') for name in os.listdir(self.bundle)))

    def test_local_install_does_not_assign_store_identity(self):
        self.assertIsNone(write_install_metadata(self.root, {}))
        self.assertIsNone(read_bundle_metadata(self.bundle))

    def test_existing_modep_sidecar_and_invalid_sidecars(self):
        path = os.path.join(self.bundle, 'patchstorage.json')
        with open(path, 'w') as handle:
            json.dump({'id': 123, 'revision': '0.9'}, handle)
        self.assertEqual(read_bundle_metadata(self.bundle), {'id': 123, 'revision': '0.9'})
        for contents in ('invalid json', '[]', '{"id":0,"revision":"1.0"}',
                         '{"id":1,"revision":{}}', 'x' * 65537):
            with open(path, 'w') as handle:
                handle.write(contents)
            self.assertIsNone(read_bundle_metadata(self.bundle))

    def test_invalid_request_metadata_never_writes_identity(self):
        for options in ({'psid': True}, {'psid': '../123'}, {'psid': -1},
                        {'psid': 12, 'psversion': None}, {'psid': 12, 'psversion': ''}):
            with self.assertRaises(ValueError):
                write_install_metadata(self.root, options)
            self.assertIsNone(read_bundle_metadata(self.bundle))

    def test_request_identity_can_be_validated_before_archive_extraction(self):
        self.assertEqual(validate_install_options({'psid': '123', 'psversion': '1.0'}),
                         {'id': 123, 'revision': '1.0'})
        self.assertIsNone(validate_install_options({}))
        with self.assertRaises(ValueError):
            validate_install_options({'psid': 'invalid'})
        self.assertIsNone(read_bundle_metadata(self.bundle))

    def test_only_manifest_directories_are_annotated(self):
        other = os.path.join(self.root, 'documentation')
        os.makedirs(other)
        write_install_metadata(self.root, {'psid': 1})
        self.assertEqual(read_bundle_metadata(self.bundle), {'id': 1, 'revision': '0.0'})
        self.assertFalse(os.path.exists(os.path.join(other, 'patchstorage.json')))

    def test_staged_paths_cannot_escape(self):
        with self.assertRaises(ValueError):
            write_install_metadata(self.root, {'psid': 1}, ['../outside.lv2'])
        with self.assertRaises(ValueError):
            write_install_metadata(self.root, {'psid': 1}, ['nested/first.lv2'])

    def test_bundle_symlink_cannot_write_outside_staging(self):
        outside = tempfile.mkdtemp(prefix='modui-patchstorage-outside-')
        link = os.path.join(self.root, 'outside.lv2')
        try:
            try:
                os.symlink(outside, link, target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest('Creating directory symlinks is unavailable')
            with self.assertRaises(ValueError):
                write_install_metadata(self.root, {'psid': 1}, ['outside.lv2'])
            self.assertFalse(os.path.exists(os.path.join(outside, 'patchstorage.json')))
        finally:
            if os.path.islink(link):
                os.unlink(link)
            shutil.rmtree(outside)


if __name__ == '__main__':
    unittest.main()
