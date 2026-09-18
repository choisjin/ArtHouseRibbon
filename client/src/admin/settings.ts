/**
 * 설정 탭: 화면 스타일(라이트 · 다크 · 기기 설정 따르기). 이 기기(브라우저)에만 기억한다.
 * 색은 style.css 의 #admin[data-theme] 변수로 바뀐다.
 */
type ThemePref = "light" | "dark" | "system";
const THEME_KEY = "ribbon.admin.theme";

function readPref(): ThemePref {
  try { return (localStorage.getItem(THEME_KEY) as ThemePref) || "system"; } catch { return "system"; }
}

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

/** 관리자 페이지에 테마를 입힌다 (처음 열 때와 바꿀 때) */
export function applyTheme(pref: ThemePref = readPref()): void {
  const theme = pref === "system" ? (systemDark.matches ? "dark" : "light") : pref;
  document.getElementById("admin")?.setAttribute("data-theme", theme);
  document.documentElement.style.colorScheme = theme;     // 달력·스크롤바 같은 기본 부품 색
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0e0b16" : "#f6f3fa");
}
systemDark.addEventListener("change", () => { if (readPref() === "system") applyTheme("system"); });

export function mountSettings(el: HTMLElement): void {
  const opts: [ThemePref, string, string][] = [
    ["light", "☀️ 라이트", "밝은 화면"],
    ["dark", "🌙 다크", "어두운 화면"],
    ["system", "📱 기기 설정 따르기", "휴대폰·컴퓨터의 다크 모드를 따라갑니다"],
  ];
  el.innerHTML = `
    <div class="settings">
      <section class="card">
        <h2>화면 스타일</h2>
        <div class="theme-options">
          ${opts.map(([v, n, d]) => `<label class="theme-opt"><input type="radio" name="theme" value="${v}" /><b>${n}</b><span class="hint">${d}</span></label>`).join("")}
        </div>
        <p class="hint">이 기기에만 저장됩니다. 맵 편집기 화면은 스타일이 따로 있습니다.</p>
      </section>
    </div>`;
  const cur = readPref();
  el.querySelectorAll<HTMLInputElement>("input[name=theme]").forEach((r) => {
    r.checked = r.value === cur;
    r.onchange = () => {
      try { localStorage.setItem(THEME_KEY, r.value); } catch { /* 저장소 없음: 이번에만 */ }
      applyTheme(r.value as ThemePref);
    };
  });
}
