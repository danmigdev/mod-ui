"""Validate the paths and bundle layout of downloaded LV2 archives."""

import posixpath
import tarfile


def _archive_path(name):
    if not name or name.startswith('/') or '\\' in name or '..' in name.split('/'):
        raise ValueError('Unsafe path in plugin archive')
    path = posixpath.normpath(name)
    if path == '.':
        return path
    if ':' in path.split('/')[0]:
        raise ValueError('Unsafe path in plugin archive')
    return path


def validate_plugin_archive(filename):
    """Return top-level bundle names; extraction must use a fresh directory."""
    bundles = set()
    manifests = set()
    try:
        with tarfile.open(filename, 'r:gz') as archive:
            for member in archive:
                path = _archive_path(member.name)
                if path == '.':
                    if not member.isdir():
                        raise ValueError('Invalid archive root')
                    continue
                top = path.split('/')[0]
                bundles.add(top)
                if '/' not in path and not member.isdir():
                    raise ValueError('Plugin archive must contain bundle directories')
                if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                    raise ValueError('Unsupported entry in plugin archive')
                if member.issym() or member.islnk():
                    link = member.linkname
                    if not link or link.startswith('/') or '\\' in link or '..' in link.split('/'):
                        raise ValueError('Unsafe link in plugin archive')
                    target = posixpath.normpath(posixpath.join(posixpath.dirname(path), link)
                                                if member.issym() else link)
                    if target.split('/')[0] != top or ':' in target:
                        raise ValueError('Link escapes its plugin bundle')
                if path == top + '/manifest.ttl' and member.isfile():
                    manifests.add(top)
    except (tarfile.TarError, EOFError, OSError) as error:
        raise ValueError('Invalid plugin archive: %s' % error)
    if not bundles or bundles != manifests:
        raise ValueError('Plugin archive must contain a manifest.ttl in every bundle')
    return sorted(bundles)
