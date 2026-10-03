#!/usr/bin/env python3
"""MODEP console entry point, compatible with the Grid build runtime."""


def run():
    from mod import webserver
    webserver.run()


if __name__ == '__main__':
    run()
