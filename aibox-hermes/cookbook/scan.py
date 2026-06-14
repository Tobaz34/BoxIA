"""Détection best-effort du hardware (RAM + VRAM GPU). Cross-platform, sans dépendance."""
from __future__ import annotations

import os
import shutil
import subprocess


def detect_ram_gb() -> float:
    # Linux : /proc/meminfo
    try:
        with open("/proc/meminfo", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    kb = int(line.split()[1])
                    return kb / (1024 * 1024)
    except OSError:
        pass
    # Windows : GlobalMemoryStatusEx via ctypes
    try:
        import ctypes

        class _MS(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_uint32), ("dwMemoryLoad", ctypes.c_uint32),
                ("ullTotalPhys", ctypes.c_uint64), ("ullAvailPhys", ctypes.c_uint64),
                ("ullTotalPageFile", ctypes.c_uint64), ("ullAvailPageFile", ctypes.c_uint64),
                ("ullTotalVirtual", ctypes.c_uint64), ("ullAvailVirtual", ctypes.c_uint64),
                ("ullAvailExtendedVirtual", ctypes.c_uint64),
            ]

        ms = _MS()
        ms.dwLength = ctypes.sizeof(_MS)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(ms))  # type: ignore[attr-defined]
        return ms.ullTotalPhys / (1024 ** 3)
    except Exception:
        pass
    # macOS / autres : sysconf
    try:
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / (1024 ** 3)
    except (ValueError, AttributeError, OSError):
        return 0.0


def detect_vram_gb() -> float:
    exe = shutil.which("nvidia-smi")
    if not exe:
        return 0.0
    try:
        out = subprocess.check_output(
            [exe, "--query-gpu=memory.total", "--format=csv,noheader,nounits"],
            text=True, timeout=5,
        )
        mbs = [int(x) for x in out.replace(",", " ").split() if x.strip().isdigit()]
        return (max(mbs) / 1024) if mbs else 0.0
    except Exception:
        return 0.0
