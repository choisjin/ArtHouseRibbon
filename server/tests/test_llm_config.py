"""대화 모델 설정: .env 로 처음 채우고, 관리자가 고른 값이 앞선다"""
from ribbon.config import Settings
from ribbon.providers import llm as llm_mod
from ribbon.settings_store import ConfigStore


def test_seed_from_env_once_then_admin_choice_wins(tmp_path):
    path = tmp_path / "settings.json"
    s = ConfigStore(path)
    s.seed_llm("ollama", "http://localhost:11434/v1", "gemma3:27b")
    s.update_llm({"provider": "mlx", "base_url": "", "model": "ddalcu/Qwen3.6-35B-A3B-MLX-Serve-4bit"})
    again = ConfigStore(path)                                     # 서버를 다시 켜도
    again.seed_llm("ollama", "http://localhost:11434/v1", "gemma3:27b")
    assert again.config.llm.provider == "mlx"
    assert again.config.llm.model.startswith("ddalcu/Qwen3.6")


def test_resolve_mlx_uses_default_url_and_autoload():
    r = llm_mod.resolve(Settings(llm_provider="ollama", llm_autoload=False), "mlx", "", "m")
    assert r.llm_base_url == "http://localhost:11234/v1"
    assert r.llm_autoload is True
    assert isinstance(llm_mod.make_llm(r), llm_mod.OpenAICompatLLM)


def test_resolve_ollama_keeps_given_url():
    r = llm_mod.resolve(Settings(), "ollama", "http://mac.local:11434/v1/", "gemma3:27b")
    assert r.llm_base_url == "http://mac.local:11434/v1"
    assert r.llm_autoload is False
    assert isinstance(llm_mod.make_llm(r), llm_mod.OllamaLLM)
