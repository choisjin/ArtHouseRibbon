from ribbon.voices import BASE_VOICES, PRESETS, get_preset, list_voices


def test_presets_mix_only_base_voices_and_sum_to_one():
    for p in PRESETS.values():
        for mix in (p.ttl, p.dp):
            assert set(mix) <= set(BASE_VOICES), p.id
            assert abs(sum(mix.values()) - 1.0) < 1e-6, p.id
        if p.child:
            pitch, formant = p.child
            assert 1.0 <= pitch <= 1.7 and 1.0 <= formant <= 1.3, p.id


def test_lab_ids_kept_and_listed():
    ids = [v["id"] for v in list_voices()]
    assert ids[:10] == BASE_VOICES
    for lab in ["YG12-0", "YG12-4", "YG14-s", "YG15-2", "YB11-3", "YB11-m50", "P1"]:
        assert lab in ids
    assert get_preset("YG12-2").child == (1.4, 1.21)
    assert get_preset("YG14-s").speed == 0.95
    assert get_preset("없는것") is None
