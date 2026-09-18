/**
 * 맵 탭: 맵 편집기(?mode=editor)를 그대로 넣는다.
 * 편집할 곳(미술실·전시장·아이들 전시실)은 편집기 안의 방 목록에서 고른다. 전시실을 고르면 같은 칸에서
 * 전시실 꾸미기(?mode=art)로 바뀐다. TV 에 보여줄 방은 대시보드 '캐릭터 조작'에 있다.
 */
export function mountMap(el: HTMLElement): { activate(): void } {
  el.innerHTML = `
    <div class="map">
      <p class="map-note hint">맵 편집은 큰 화면에서 하세요. <a href="/?mode=editor" target="_blank">↗ 새 창으로 열기</a></p>
      <iframe id="map-frame" title="맵 편집기"></iframe>
    </div>`;
  const frame = el.querySelector("#map-frame") as HTMLIFrameElement;
  return {
    activate() {
      if (!frame.src) frame.src = "/?mode=editor&embed=1";   // 처음 열 때만 (편집 중인 화면을 지키려고)
    },
  };
}
