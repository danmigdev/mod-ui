"""Keep Tornado 4's callback API usable on current Python runtimes."""

import collections
import collections.abc

# Tornado 4 uses aliases removed from collections in Python 3.10.
for _alias in ('Mapping', 'MutableMapping', 'Sequence'):
    if not hasattr(collections, _alias):
        setattr(collections, _alias, getattr(collections.abc, _alias))
