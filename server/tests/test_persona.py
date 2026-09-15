from ribbon.persona.ribbon import call, subj, listening_prompt


def test_vocative_particle():
    assert call("하준") == "하준아"
    assert call("지우") == "지우야"
    assert call("민수") == "민수야"
    assert call("서연") == "서연아"


def test_subject_particle():
    assert subj("하준") == "하준이가"
    assert subj("지우") == "지우가"


def test_listening_prompt():
    assert listening_prompt("하준") == "응 하준아, 말해봐."
