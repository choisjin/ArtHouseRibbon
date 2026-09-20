/**
 * 리본 사이드 페이지 메뉴 (?mode=home). 메인 홈페이지(arthouseribbon.com)는 따로 있고,
 * 이 서버는 ribbon.arthouseribbon.com 처럼 옆에 붙는 쪽이다 (docs/REMOTE.md).
 *
 * 도메인으로 들어오면 (맥미니 자신이 아니면) 주소에 mode 가 없을 때 이 화면이 뜬다.
 * 폰으로 주소만 치고 들어온 사람이 무엇을 할지 고를 수 있게 하는 것이 목적이다.
 */
const HOME_URL = "https://arthouseribbon.com";

interface Item { mode: string; icon: string; title: string; desc: string; admin?: boolean }

const ITEMS: Item[] = [
  { mode: "snap", icon: "🎨", title: "작품 찍어 보내기", desc: "폰으로 아이 작품을 찍어 보냅니다" },
  { mode: "art", icon: "🖼", title: "전시실 꾸미기", desc: "보낸 작품을 아이 전시실 벽에 겁니다", admin: true },
  { mode: "admin", icon: "⚙️", title: "관리자", desc: "아이들·캐릭터·음악·마이크 설정", admin: true },
  { mode: "tv", icon: "📺", title: "TV 화면", desc: "교실 TV 에 띄우는 리본이 화면" },
  { mode: "mic", icon: "🎙", title: "마이크", desc: "무선 마이크 수신기를 꽂은 기기에서 열어 둡니다" },
  { mode: "editor", icon: "🗺", title: "맵 편집기", desc: "방 가구 배치 (컴퓨터에서)", admin: true },
];

export async function startHome(): Promise<void> {
  const { fetchMe, logout } = await import("../auth/index");
  const me = (await fetchMe()).user;
  const items = ITEMS.filter((i) => !i.admin || me?.role === "admin");
  render(items, me?.name ?? "", logout);
}

function render(items: Item[], who: string, logout: () => void): void {
  document.body.innerHTML = `
    <style>
      html { background: #f6f3fa; }
      body { margin: 0; min-height: 100vh; background: #f6f3fa; color: #221c2e; font-family: system-ui, -apple-system, sans-serif;
        padding: 24px 16px; padding-bottom: max(24px, env(safe-area-inset-bottom)); }
      .wrap { max-width: 460px; margin: 0 auto; }
      h1 { font-size: 22px; margin: 0 0 4px; }
      .sub { color: #7a7289; font-size: 14px; margin: 0 0 20px; }
      a.item { display: flex; align-items: center; gap: 14px; text-decoration: none; color: inherit;
        background: #fff; border: 1px solid #e3dcee; border-radius: 16px; padding: 16px; margin-bottom: 10px; }
      a.item .ic { font-size: 28px; }
      a.item b { display: block; font-size: 17px; }
      a.item span { font-size: 13px; color: #7a7289; }
      .back { display: inline-block; margin-top: 16px; font-size: 14px; color: #7b4bd8; }
      .who { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; font-size: 14px; color: #4d4560; }
      .who button { font: inherit; border: 1px solid #cfc6dc; background: #fff; color: #4d4560; border-radius: 10px; padding: 6px 12px; }
    </style>
    <div class="wrap">
      <h1>🎀 리본</h1>
      <p class="sub">아트하우스 리본 교실 화면들</p>
      ${who ? `<div class="who"><span>${who} 님</span><button data-act="logout">로그아웃</button></div>` : ""}
      ${items.map((i) => `<a class="item" href="/?mode=${i.mode}">
        <span class="ic">${i.icon}</span><span><b>${i.title}</b><span>${i.desc}</span></span></a>`).join("")}
      <a class="back" href="${HOME_URL}">← 학원 홈페이지로</a>
    </div>`;
  document.querySelector("[data-act=logout]")?.addEventListener("click", () => logout());
}
