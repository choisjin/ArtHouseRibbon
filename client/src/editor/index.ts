import "./style.css";

/**
 * 맵 편집기 (?mode=editor). 화면 골격을 깔고 app.js(Character_Creator 배치 편집기 이식본)를 실행한다.
 * app.js 는 불러오는 순간 DOM 을 찾으므로 골격을 먼저 넣어야 한다.
 */
const MARKUP = `
<header id="toolbar">
  <strong class="title">맵 편집기</strong>
  <select id="room" title="방 선택">
    <option value="classroom">미술실</option>
    <option value="gallery">전시장</option>
  </select>
  <div class="group" role="group" aria-label="보기">
    <button data-view="persp" class="view on" title="1">원근</button>
    <button data-view="top" class="view" title="2">위에서</button>
    <button data-view="tv" class="view" title="3">TV 화면</button>
  </div>
  <div class="group">
    <label><input type="checkbox" id="snap" checked> 격자</label>
    <select id="gridStep" title="격자 간격">
      <option value="0.05">5cm</option><option value="0.1" selected>10cm</option>
      <option value="0.25">25cm</option><option value="0.5">50cm</option>
    </select>
    <select id="rotStep" title="회전 단위">
      <option value="5">5°</option><option value="15" selected>15°</option>
      <option value="45">45°</option><option value="90">90°</option>
    </select>
  </div>
  <div class="group">
    <button id="undo" title="Ctrl+Z">↶ 실행취소</button>
    <button id="redo" title="Ctrl+Y">↷ 다시실행</button>
  </div>
  <div class="group">
    <button id="save" class="primary" title="Ctrl+S">저장</button>
    <span id="dirty"></span>
    <button id="exportFile">파일로 내보내기</button>
    <label class="button">파일 불러오기<input type="file" id="importFile" accept=".json" hidden></label>
    <button id="reset" title="Character_Creator 카탈로그의 기본 배치로 (저장해야 반영)">기본 배치</button>
  </div>
  <div class="group">
    <button id="setActive" title="관리자 페이지의 'TV 에 보여줄 방'과 같습니다">📺 TV 에 보여주기</button>
    <button id="renderBg" title="블렌더로 TV 배경을 다시 렌더 (저장하면 자동으로도 함)">🎬 배경 렌더</button>
    <span id="renderStatus"></span>
    <a class="button" id="adminLink" href="/?mode=admin">관리자 페이지</a>
  </div>
</header>

<main>
  <aside id="left">
    <div class="mainTabs" role="tablist">
      <button class="mainTab" data-tab="catalog" role="tab">카탈로그</button>
      <button class="mainTab" data-tab="list" role="tab">배치 목록 <small id="listCount"></small></button>
      <button class="mainTab" data-tab="art" role="tab">그림 <small id="artCount"></small></button>
    </div>

    <section class="tabPanel" data-panel="catalog">
      <div id="catTabs" class="tabs" role="tablist"></div>
      <div id="catalog" class="cardGrid"></div>
      <p class="hint">누르면 방 가운데(또는 마지막으로 누른 바닥 위치)에 배치됩니다.</p>
    </section>

    <section class="tabPanel" data-panel="list" hidden>
      <ul id="itemList" class="list"></ul>
      <div class="pager">
        <button id="pgFirst" title="처음">«</button>
        <button id="pgPrev" title="이전">‹</button>
        <span id="pgInfo"></span>
        <button id="pgNext" title="다음">›</button>
        <button id="pgLast" title="끝">»</button>
      </div>
      <div id="storageBox" hidden>
        <h3>배치 해제한 가구 <small id="storageCount"></small></h3>
        <ul id="storage" class="list"></ul>
      </div>
    </section>

    <section class="tabPanel" data-panel="art" hidden>
      <label class="button upload">＋ 그림 올리기 (PNG · JPG · WEBP)<input type="file" id="artUpload" accept="image/png,image/jpeg,image/webp" multiple hidden></label>
      <p class="hint">그림을 누른 뒤 벽·가벽·이젤을 클릭하면 걸립니다. 파일을 3D 화면에 끌어다 놓아도 됩니다.</p>
      <div id="artLibrary"></div>
    </section>

    <h2>선택한 항목</h2>
    <div id="noSel" class="hint">가구나 그림을 누르면 여기에서 편집할 수 있습니다.</div>
    <div id="artSel" hidden>
      <div class="selHead">
        <img id="artThumb" alt="">
        <div>
          <div class="name" id="artName"></div>
          <div class="sub" id="artWhere"></div>
        </div>
      </div>
      <div class="fields two">
        <label>가로 (m) <input type="number" id="artW" step="0.05" min="0.05"></label>
        <label>세로 (m) <input type="number" id="artH" step="0.05" min="0.05"></label>
      </div>
      <input type="range" id="artScale" min="0.1" max="4" step="0.01" title="비율을 유지한 채 크기 조절">
      <div class="fields two">
        <label>좌우 (m) <input type="number" id="artU" step="0.05"></label>
        <label id="artVRow">높이 (m) <input type="number" id="artV" step="0.05" title="그림 중심 높이"></label>
      </div>
      <div class="fields">
        <label>액자 <select id="artFrame">
          <option value="canvas">캔버스 (액자 없음)</option>
          <option value="black">검정 액자</option>
          <option value="wood">나무 액자</option>
          <option value="white">흰 액자</option>
        </select></label>
      </div>
      <div class="row">
        <button id="artCenter">가운데로</button>
        <button id="artEye">눈높이 1.5m</button>
        <button id="artMove">다른 곳에 걸기</button>
        <button id="artRemove" class="danger">그림 내리기</button>
      </div>
      <p class="hint">드래그: 다른 벽·가벽·이젤로 옮기기 · [ / ] 크기 · Del 내리기</p>
    </div>
    <div id="sel" hidden>
      <div class="selHead">
        <img id="selThumb" alt="">
        <div>
          <div class="name" id="selName"></div>
          <div class="sub" id="selId"></div>
        </div>
      </div>
      <div class="fields three">
        <label>X (m) <input type="number" id="fx" step="0.05"></label>
        <label>Y (m) <input type="number" id="fy" step="0.05"></label>
        <label id="rotField">회전 (°) <input type="number" id="frot" step="1"></label>
      </div>
      <div class="row" id="rotButtons">
        <button id="rotL">⟲ 왼쪽</button>
        <button id="rotR">⟳ 오른쪽</button>
        <button id="rot90">90° 돌리기</button>
        <button id="toWall">벽에 붙이기</button>
      </div>
      <div class="row" id="itemButtons">
        <button id="dup">복제</button>
        <button id="remove" class="danger">배치 해제</button>
      </div>
      <div class="row" id="replaceRow">
        <select id="replaceType"></select>
        <button id="replace">교체</button>
      </div>
    </div>

    <h2>경고</h2>
    <ul id="warnings" class="list"></ul>

  </aside>

  <section id="viewport">
    <canvas id="canvas"></canvas>
    <div id="loading">불러오는 중…</div>
    <div id="placing" hidden></div>
    <div id="dropHint" hidden>여기에 놓으면 그림을 올립니다</div>
    <div id="help">
      드래그: 이동 · R / Shift+R: 회전 · Del: 배치 해제 · Ctrl+D: 복제 · 방향키: 조금 이동 · Esc: 선택 해제<br>
      빈 곳 드래그: 시점 회전(원근) / 화면 이동(위에서) · 휠: 확대
    </div>
  </section>
</main>
<div id="toast"></div>`;

export async function startEditor(): Promise<void> {
  document.title = "맵 편집기";
  document.body.innerHTML = MARKUP;
  document.body.classList.add("editor");
  // 관리자 페이지 '맵' 탭 안에 들어갈 때는 관리자 페이지로 가는 링크가 필요 없다
  if (new URLSearchParams(location.search).has("embed")) document.getElementById("adminLink")?.remove();
  await import("./app.js");
}
