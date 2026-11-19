"""Explicit offline-test plugin: load with -p before collecting any tests.

Unlike a test fixture this prohibits outbound TCP during import/collection too.
Not enabled for developer-requested staging/physical-device acceptance.
"""
import socket

_connect = socket.socket.connect
_connect_ex = socket.socket.connect_ex


def _check(address):
    if isinstance(address, tuple) and address[0] not in ("127.0.0.1", "::1", "localhost"):
        raise AssertionError("Offline verification forbids non-loopback network connections")


def _guarded_connect(sock, address):
    _check(address)
    return _connect(sock, address)


def _guarded_connect_ex(sock, address):
    _check(address)
    return _connect_ex(sock, address)


socket.socket.connect = _guarded_connect
socket.socket.connect_ex = _guarded_connect_ex
