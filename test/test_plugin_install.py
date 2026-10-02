"""Downloaded plugin validation and store identity before native loading."""

import io
import json
import os
import tarfile
from unittest.mock import patch

import pytest

from mod.plugin_install import validate_plugin_archive


def archive(path, entries):
    with tarfile.open(str(path), 'w:gz') as handle:
        for name, data, link in entries:
            member = tarfile.TarInfo(name)
            if link is not None:
                member.type = tarfile.SYMTYPE
                member.linkname = link
                handle.addfile(member)
            else:
                data = data.encode('utf-8')
                member.size = len(data)
                handle.addfile(member, io.BytesIO(data))


def test_accepts_nested_resources_and_internal_shared_library_links(tmp_path):
    package = tmp_path / 'plugins.tar.gz'
    archive(package, [('bundle.lv2/manifest.ttl', 'manifest', None),
                      ('bundle.lv2/lib/real.so', 'binary', None),
                      ('bundle.lv2/plugin.so', '', 'lib/real.so')])
    assert validate_plugin_archive(str(package)) == ['bundle.lv2']


@pytest.mark.parametrize('name,link', [('../outside', None), ('/outside', None),
                                     ('bundle.lv2/../../outside', None),
                                     ('bundle.lv2/plugin.so', '/outside'),
                                     ('bundle.lv2/plugin.so', '../outside'),
                                     ('bundle.lv2/plugin.so', '../../outside'),
                                     ('bundle.lv2/plugin.so', 'alias/..')])
def test_rejects_paths_and_links_escaping_the_bundle(tmp_path, name, link):
    package = tmp_path / 'plugins.tar.gz'
    archive(package, [('bundle.lv2/manifest.ttl', 'manifest', None), (name, 'data', link)])
    with pytest.raises(ValueError):
        validate_plugin_archive(str(package))


def test_requires_manifest_and_rejects_corrupt_archive(tmp_path):
    package = tmp_path / 'plugins.tar.gz'
    archive(package, [('bundle.lv2/plugin.so', 'data', None)])
    with pytest.raises(ValueError):
        validate_plugin_archive(str(package))
    package.write_bytes(b'broken archive')
    with pytest.raises(ValueError):
        validate_plugin_archive(str(package))


def test_truncated_gzip_returns_install_failure_and_cleans_upload(tmp_path):
    from mod import webserver
    package = tmp_path / 'plugins.tar.gz'
    archive(package, [('bundle.lv2/manifest.ttl', 'manifest', None)])
    package.write_bytes(package.read_bytes()[:20])
    responses = []
    with patch.object(webserver, 'run_command') as extract:
        webserver.install_package(str(package), responses.append)
    extract.assert_not_called()
    assert responses[0]['ok'] is False
    assert not package.exists()


def test_installer_adds_metadata_before_bundle_loading_and_isolates_packages(tmp_path):
    from mod import webserver
    package = tmp_path / 'plugins.tar.gz'
    archive(package, [('bundle.lv2/manifest.ttl', 'manifest', None)])
    unrelated = tmp_path / 'other-upload'
    unrelated.write_bytes(b'other upload')
    responses, staging_paths = [], []

    def extract(args, cwd, callback):
        staging_paths.append(cwd)
        with tarfile.open(args[-1]) as handle:
            handle.extractall(cwd, filter='data')
        callback((0, b'', b''))

    def load(callback, staging_dir):
        with open(os.path.join(staging_dir, 'bundle.lv2', 'patchstorage.json')) as handle:
            assert json.load(handle) == {'id': 123, 'revision': '2.1'}
        assert os.listdir(staging_dir) == ['bundle.lv2']
        callback({'ok': True, 'installed': ['urn:test'], 'removed': []})

    with patch.object(webserver, 'run_command', extract), \
            patch.object(webserver, 'install_bundles_in_tmp_dir', load):
        webserver.install_package(str(package), responses.append,
                                  {'psid': '123', 'psversion': '2.1'})
    assert responses[0]['ok'] is True
    assert unrelated.read_bytes() == b'other upload'
    assert not package.exists()
    assert not os.path.exists(staging_paths[0])


def test_failed_extraction_does_not_install_partial_bundles(tmp_path):
    from mod import webserver
    package = tmp_path / 'plugins.tar.gz'
    archive(package, [('bundle.lv2/manifest.ttl', 'manifest', None)])
    responses = []
    with patch.object(webserver, 'run_command',
                      side_effect=lambda args, cwd, callback: callback((1, b'', b'failed'))), \
            patch.object(webserver, 'install_bundles_in_tmp_dir') as load:
        webserver.install_package(str(package), responses.append)
    load.assert_not_called()
    assert responses[0]['ok'] is False
    assert responses[0]['installed'] == []
    assert not package.exists()


def test_invalid_store_metadata_does_not_extract_or_load(tmp_path):
    from mod import webserver
    package = tmp_path / 'plugins.tar.gz'
    archive(package, [('bundle.lv2/manifest.ttl', 'manifest', None)])
    responses = []
    with patch.object(webserver, 'run_command') as extract:
        webserver.install_package(str(package), responses.append, {'psid': '../123'})
    extract.assert_not_called()
    assert responses[0]['ok'] is False
