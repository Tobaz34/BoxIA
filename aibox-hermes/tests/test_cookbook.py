"""Tests du Cookbook (recommandation modèle selon hardware)."""
import recommend as rec


def test_cpu_8gb_picks_4b():
    assert rec.recommend(ram_gb=8, vram_gb=0)["recommended"] == "qwen3:4b"


def test_cpu_4gb_picks_smallest():
    assert rec.recommend(ram_gb=4, vram_gb=0)["recommended"] == "qwen3:1.7b"


def test_gpu_12gb_quality_picks_8b():
    # À 64K (exigence Hermes), le 14b déborde 12 Go → le bon choix est le 8b (mesuré live).
    r = rec.recommend(ram_gb=32, vram_gb=12, prefer="quality")
    assert r["recommended"] == "qwen3:8b"
    assert r["fits"] is True


def test_gpu_12gb_speed_steps_down():
    r = rec.recommend(ram_gb=32, vram_gb=12, prefer="speed")
    assert r["recommended"] == "qwen3:4b"   # un cran sous le meilleur (8b)


def test_gpu_12gb_card_reports_1199():
    # Un GPU 12 Go rapporte ~11,99 Go (12282 MiB) → le 8b doit quand même passer.
    assert rec.recommend(ram_gb=31, vram_gb=11.99, prefer="quality")["recommended"] == "qwen3:8b"


def test_gpu_24gb_picks_14b():
    # À 64K, le 32b exige ~30 Go → sur 24 Go, le meilleur qui tient est le 14b.
    assert rec.recommend(ram_gb=64, vram_gb=24)["recommended"] == "qwen3:14b"


def test_speed_never_equals_quality_on_capable_hw():
    q = rec.recommend(32, 12, "quality")["recommended"]
    s = rec.recommend(32, 12, "speed")["recommended"]
    assert q != s


def test_tiny_hardware_still_returns_something():
    r = rec.recommend(ram_gb=2, vram_gb=0)
    assert r["recommended"] == "qwen3:1.7b"
    assert r["fits"] is False
