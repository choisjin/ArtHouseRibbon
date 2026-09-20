/**
 * 폰으로 작품 찍어 보내기 (?mode=snap). 관리자 설정 → 카메라 탭의 QR 로 연다.
 *
 * 같은 와이파이에서 http 로 열기 때문에 브라우저가 카메라 API(getUserMedia)를 막는다 (보안 맥락이 아님).
 * 그래서 폰의 기본 카메라 앱을 여는 방식(<input type="file" capture>)을 쓴다. 화질도 이 쪽이 좋다.
 * https 로 연 경우처럼 카메라 API 를 쓸 수 있으면 화면 안 미리보기도 함께 보여 준다.
 *
 * 보낸 사진은 서버 /api/artworks 에 저장된다 (data/artworks/). 벽에 거는 것은 전시실 꾸미기(?mode=art)에서 한다.
 */
const MAX_EDGE = 2000;        // 긴 변 이 길이로 줄여서 보낸다 (폰 사진은 4000px 이 넘는다)
const KID_KEY = "ribbon.snap.kid";

interface Kid { id: string; name: string; nickname?: string }

export async function startSnap(): Promise<void> {
  document.body.innerHTML = PAGE;
  const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
  const kidSel = $<HTMLSelectElement>("#kid");
  const file = $<HTMLInputElement>("#file");
  const pick = $<HTMLInputElement>("#pick");
  const shot = $<HTMLImageElement>("#shot");
  const msg = $<HTMLElement>("#msg");
  const sent = $<HTMLElement>("#sent");
  const before = $<HTMLElement>("#before");
  const after = $<HTMLElement>("#after");

  let pendingName = "";
  const say = (text: string, kind: "" | "ok" | "err" = "") => { msg.textContent = text; msg.className = kind; };

  const kids = await fetch("/api/kids").then((r) => r.json() as Promise<Kid[]>).catch(() => []);
  if (!kids.length) { say("관리자 페이지에서 아이를 먼저 추가하세요", "err"); return; }
  kidSel.innerHTML = [...kids].sort((a, b) => a.name.localeCompare(b.name, "ko"))
    .map((k) => `<option value="${k.id}">${esc(k.name)}</option>`).join("");
  try {
    const saved = localStorage.getItem(KID_KEY);
    if (saved && kids.some((k) => k.id === saved)) kidSel.value = saved;
  } catch { /* 저장소 없음 */ }
  kidSel.onchange = () => { try { localStorage.setItem(KID_KEY, kidSel.value); } catch { /* 저장소 없음 */ } };

  /** 찍거나 고른 사진을 미리보기로 (긴 변 MAX_EDGE 로 줄이고 JPEG 로) */
  async function load(f: File): Promise<void> {
    say("사진을 여는 중…");
    try {
      const url = URL.createObjectURL(f);
      const img = new Image();
      await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("사진을 열지 못했습니다")); img.src = url; });
      const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      shot.src = c.toDataURL("image/jpeg", 0.88);
      shot.dataset.w = String(c.width);
      shot.dataset.h = String(c.height);
      pendingName = f.name || "작품";
      before.hidden = true;
      after.hidden = false;
      say(`${c.width} × ${c.height} · 보낼 준비가 됐어요`);
    } catch (e) {
      say(String(e), "err");
    }
  }
  file.onchange = () => { if (file.files?.[0]) void load(file.files[0]); file.value = ""; };
  pick.onchange = () => { if (pick.files?.[0]) void load(pick.files[0]); pick.value = ""; };
  $<HTMLButtonElement>("#again").onclick = () => { before.hidden = false; after.hidden = true; say(""); };

  $<HTMLButtonElement>("#send").onclick = async () => {
    const btn = $<HTMLButtonElement>("#send");
    btn.disabled = true;
    say("보내는 중…");
    try {
      const kid = kids.find((k) => k.id === kidSel.value);
      const r = await fetch("/api/artworks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data: shot.src, width: Number(shot.dataset.w), height: Number(shot.dataset.h),
          kid_id: kidSel.value,
          name: `${kid?.name ?? ""} ${new Date().toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`.trim() || pendingName,
        }),
      });
      if (!r.ok) throw new Error((await r.text().catch(() => "")) || `${r.status}`);
      const done = await r.json() as { new: boolean };
      const thumb = document.createElement("img");
      thumb.src = shot.src;
      sent.prepend(thumb);
      before.hidden = false;
      after.hidden = true;
      say(done.new ? "보냈어요! 또 찍어도 돼요 🎉" : "이미 보낸 사진이에요 (그대로 두었어요)", "ok");
    } catch (e) {
      say(`보내지 못했어요: ${e}`, "err");
    } finally {
      btn.disabled = false;
    }
  };

  // 카메라 API 를 쓸 수 있으면 (https 나 localhost) 화면 안 미리보기도 켠다
  if (navigator.mediaDevices?.getUserMedia) {
    const live = $<HTMLVideoElement>("#live");
    try {
      live.srcObject = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 } }, audio: false,
      });
      live.hidden = false;
      $<HTMLButtonElement>("#snap").hidden = false;
      $<HTMLButtonElement>("#snap").onclick = () => {
        const c = document.createElement("canvas");
        const scale = Math.min(1, MAX_EDGE / Math.max(live.videoWidth, live.videoHeight));
        c.width = Math.round(live.videoWidth * scale);
        c.height = Math.round(live.videoHeight * scale);
        c.getContext("2d")!.drawImage(live, 0, 0, c.width, c.height);
        shot.src = c.toDataURL("image/jpeg", 0.88);
        shot.dataset.w = String(c.width);
        shot.dataset.h = String(c.height);
        before.hidden = true;
        after.hidden = false;
        say(`${c.width} × ${c.height} · 보낼 준비가 됐어요`);
      };
    } catch { /* 권한 거절: 기본 카메라 앱으로 찍는다 */ }
  }
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const PAGE = `
<style>
  :root { color-scheme: light; }
  html { background: #f6f3fa; }      /* index.html 의 어두운 기본 배경을 덮는다 */
  body { margin: 0; min-height: 100vh; background: #f6f3fa; color: #221c2e; font-family: system-ui, -apple-system, sans-serif;
    padding: 16px; padding-bottom: max(16px, env(safe-area-inset-bottom)); }
  h1 { font-size: 20px; margin: 0 0 12px; }
  label { display: block; font-size: 13px; color: #4d4560; margin-bottom: 4px; }
  select, button { font: inherit; }
  select { width: 100%; padding: 12px; border-radius: 12px; border: 1px solid #cfc6dc; background: #fff; margin-bottom: 16px; }
  .big { display: block; width: 100%; padding: 18px; font-size: 19px; font-weight: 700; border-radius: 16px;
    border: none; background: #7b4bd8; color: #fff; margin-bottom: 10px; }
  .big.sub { background: #fff; color: #4d4560; border: 1px solid #cfc6dc; font-weight: 600; }
  .big:disabled { opacity: .6; }
  img#shot, video#live { width: 100%; border-radius: 16px; background: #000; margin-bottom: 12px; display: block; }
  #msg { min-height: 22px; font-size: 14px; color: #4d4560; margin: 4px 0 12px; }
  #msg.ok { color: #2e9e55; font-weight: 700; }
  #msg.err { color: #d8453a; font-weight: 700; }
  #sent { display: flex; gap: 8px; flex-wrap: wrap; }
  #sent img { width: 72px; height: 72px; object-fit: cover; border-radius: 10px; }
  .hint { font-size: 13px; color: #7a7289; line-height: 1.5; }
  input[type=file] { display: none; }
</style>
<h1>🎨 작품 찍어 보내기</h1>
<label for="kid">누구 작품인가요?</label>
<select id="kid"></select>
<div id="before">
  <video id="live" autoplay playsinline muted hidden></video>
  <button id="snap" class="big" hidden>● 지금 찍기</button>
  <button class="big" onclick="document.getElementById('file').click()">📷 사진 찍기</button>
  <button class="big sub" onclick="document.getElementById('pick').click()">🖼 앨범에서 고르기</button>
  <input id="file" type="file" accept="image/*" capture="environment" />
  <input id="pick" type="file" accept="image/*" />
</div>
<div id="after" hidden>
  <img id="shot" alt="찍은 사진" />
  <button id="send" class="big">보내기</button>
  <button id="again" class="big sub">다시 찍기</button>
</div>
<p id="msg"></p>
<div id="sent"></div>
<p class="hint">보낸 사진은 리본 서버에 저장됩니다. 전시실 벽에 거는 것은 컴퓨터에서 <b>전시실 꾸미기</b> 화면으로 합니다.</p>`;
