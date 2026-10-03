#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Patchstorage configuration and MODEP-compatible installation metadata.

The metadata lives beside the installed LV2 manifest, so existing MODEP
installations retain their store identity without changing the native ABI.
"""

import json
import os
import platform
import sys
import tempfile
from urllib.parse import urlparse


DEFAULT_API_URL = 'https://patchstorage.com/api/beta/patches'
DEFAULT_PLATFORM_ID = 8046
ARMHF_TARGET_ID = 8278
AARCH64_TARGET_ID = 8280
AMD64_TARGET_ID = 8279
METADATA_FILENAME = 'patchstorage.json'
MAX_METADATA_SIZE = 65536


def _environment_value(environ, name, default=None):
    # Keep the original MODEP variables while supporting the MOD namespace.
    for key in ('MOD_' + name, name):
        value = environ.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return default


def _positive_id(value, name):
    if isinstance(value, bool):
        raise ValueError('%s must be a positive integer' % name)
    text = str(value).strip()
    if not text or any(char not in '0123456789' for char in text):
        raise ValueError('%s must be a positive integer' % name)
    number = int(text)
    if number <= 0:
        raise ValueError('%s must be a positive integer' % name)
    return number


def _boolean(value, name):
    text = str(value).strip().lower()
    if text in ('1', 'true', 'yes', 'on'):
        return True
    if text in ('0', 'false', 'no', 'off'):
        return False
    raise ValueError('%s must be enabled or disabled' % name)


def resolve_target(environ=None, machine=None, pointer_bits=None):
    """Select plugin binaries for the running process, preserving overrides.

    A 64-bit kernel may run a 32-bit Patchbox userspace. The Python process
    width is therefore part of the decision, instead of relying on uname.
    """
    if environ is None:
        environ = os.environ
    explicit = _environment_value(environ, 'PATCHSTORAGE_TARGET_ID')
    if explicit is not None:
        return _positive_id(explicit, 'PATCHSTORAGE_TARGET_ID')

    if machine is None:
        machine = platform.machine()
    if pointer_bits is None:
        pointer_bits = 64 if sys.maxsize > 2**32 else 32
    machine = machine.lower()

    if machine in ('aarch64', 'arm64', 'armv8l', 'armv7l'):
        if pointer_bits == 64:
            value = _environment_value(environ, 'PATCHSTORAGE_AARCH64_TARGET_ID', AARCH64_TARGET_ID)
        else:
            value = _environment_value(environ, 'PATCHSTORAGE_ARMHF_TARGET_ID', ARMHF_TARGET_ID)
        return _positive_id(value, 'PATCHSTORAGE_TARGET_ID')
    if machine in ('x86_64', 'amd64') and pointer_bits == 64:
        return AMD64_TARGET_ID
    return None


def get_config(environ=None, machine=None, pointer_bits=None, linux=None):
    """Return catalog settings with both MOD and MODEP environment names."""
    if environ is None:
        environ = os.environ
    if linux is None:
        linux = sys.platform.startswith('linux')
    target_id = resolve_target(environ, machine, pointer_bits)
    enabled = _boolean(_environment_value(environ, 'PATCHSTORAGE_ENABLED',
                                         '1' if linux and target_id is not None else '0'),
                       'PATCHSTORAGE_ENABLED')
    if enabled and target_id is None:
        raise ValueError('PATCHSTORAGE_TARGET_ID is required for this architecture')

    api_url = _environment_value(environ, 'PATCHSTORAGE_API_URL', DEFAULT_API_URL).rstrip('/')
    parsed_url = urlparse(api_url)
    if parsed_url.scheme not in ('http', 'https') or not parsed_url.netloc:
        raise ValueError('PATCHSTORAGE_API_URL must be an HTTP or HTTPS URL')
    return {
        'enabled': enabled,
        'api_url': api_url,
        'platform_id': _positive_id(_environment_value(environ, 'PATCHSTORAGE_PLATFORM_ID',
                                                       DEFAULT_PLATFORM_ID),
                                    'PATCHSTORAGE_PLATFORM_ID'),
        'target_id': target_id,
    }


def _normalize_metadata(data):
    if not isinstance(data, dict):
        raise ValueError('Patchstorage metadata must be an object')
    patch_id = _positive_id(data.get('id'), 'Patchstorage id')
    revision = data.get('revision')
    if isinstance(revision, bool) or not isinstance(revision, (str, int, float)):
        raise ValueError('Patchstorage revision must be a string or number')
    revision = str(revision).strip()
    if not revision or len(revision) > 256:
        raise ValueError('Patchstorage revision must contain between 1 and 256 characters')
    return {'id': patch_id, 'revision': revision}


def read_bundle_metadata(bundle_path):
    """Return validated metadata, or None for local/unreadable bundles."""
    try:
        with open(os.path.join(bundle_path, METADATA_FILENAME), 'r', encoding='utf-8') as handle:
            contents = handle.read(MAX_METADATA_SIZE + 1)
        if len(contents) > MAX_METADATA_SIZE:
            return None
        return _normalize_metadata(json.loads(contents))
    except (OSError, ValueError, TypeError):
        # A broken sidecar must not hide an otherwise valid installed plugin.
        return None


def validate_install_options(options):
    """Validate store identity without creating or modifying any files."""
    if options.get('psid') is None:
        return None
    return _normalize_metadata({
        'id': options['psid'],
        'revision': options.get('psversion', '0.0'),
    })


def write_install_metadata(staging_dir, options, bundles=None):
    """Record store identity before staged LV2 bundles enter the Lilv world.

    Return the canonical metadata, or None for a non-Patchstorage install.
    Invalid supplied metadata raises ValueError; filesystem errors propagate
    so the caller can report an unsuccessful installation.
    """
    metadata = validate_install_options(options)
    if metadata is None:
        return None
    staging_root = os.path.normcase(os.path.realpath(staging_dir))
    if bundles is None:
        bundles = os.listdir(staging_dir)
    for name in bundles:
        if not name or name in ('.', '..') or '/' in name or '\\' in name:
            raise ValueError('Invalid staged plugin bundle name')
        bundle_path = os.path.join(staging_dir, name)
        if not os.path.isdir(bundle_path):
            continue
        resolved_bundle = os.path.normcase(os.path.realpath(bundle_path))
        if not resolved_bundle.startswith(staging_root.rstrip(os.sep) + os.sep):
            raise ValueError('Plugin bundle escapes the staging directory')
        if not os.path.isfile(os.path.join(bundle_path, 'manifest.ttl')):
            continue

        descriptor, temporary_path = tempfile.mkstemp(prefix='.patchstorage-', dir=bundle_path)
        try:
            with os.fdopen(descriptor, 'w', encoding='utf-8') as handle:
                json.dump(metadata, handle, sort_keys=True)
                handle.write('\n')
            os.replace(temporary_path, os.path.join(bundle_path, METADATA_FILENAME))
        finally:
            if os.path.exists(temporary_path):
                os.unlink(temporary_path)
    return metadata
