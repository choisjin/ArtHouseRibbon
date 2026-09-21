import * as THREE from "three";
import { applyLook, loadDoll, specOf, type DollAsset } from "./doll";
import { rad, toThree } from "./types";

/**
 * 전시실에 세워 두는 캐릭터 (2026-09-21 "캐릭터까지 배치할 수 있어?").
 *
 * 올리·서율이를 전시실 바닥 한 자리에 세워 둔다 — 아이 전시실을 꾸밀 때 놓고, 부모님 전시실과 내보낸 .html 에도 같이 나온다.
 * TV 는 살아 있는 캐릭터가 이미 돌아다니므로 **TV 화면에는 세우지 않는다** (둘이 겹쳐 보이지 않게).
 * 자세는 glb 에 들어 있는 동작을 그대로 돌린다 (Sway 처럼 가만히 있는 동작이 기본).
 */
export interface Guide {
  who: string;                 // 캐릭터 id (client/public/world/<id>.glb, 아이마다 만들어 넣는다)
  x: number;                   // 바닥 자리 (블렌더 좌표, doll_spot 과 같은 기준)
  y: number;
  rot: number;                 // 보는 쪽 (도)
  pose: string;                // glb 동작 이름 (POSES)
}

export const POSES: { id: string; name: string }[] = [
  { id: "Sway", name: "가만히" },
  { id: "Greet", name: "인사" },
  { id: "Clap", name: "박수" },
  { id: "Point", name: "가리키기" },
  { id: "LookUp", name: "올려다보기" },
  { id: "Tilt", name: "갸웃" },
  { id: "Sit", name: "앉기" },
];

export const DEFAULT_GUIDE: Omit<Guide, "who"> = { x: 0, y: 0, rot: 0, pose: "Sway" };   // rot 0 = 보는 사람 쪽

export function guideOf(raw: Partial<Guide> | null | undefined): Guide | null {
  if (!raw || typeof raw !== "object" || !raw.who) return null;
  const num = (v: unknown, d: number): number => (typeof v === "number" && isFinite(v) ? v : d);
  return {
    who: raw.who,
    x: num(raw.x, 0), y: num(raw.y, 0), rot: num(raw.rot, 0),
    pose: POSES.some((p) => p.id === raw.pose) ? raw.pose! : "Sway",
  };
}

export interface GuideModel {
  group: THREE.Group;
  /** 매 프레임 (초). 자세 동작을 돌린다 */
  update(dt: number): void;
  place(g: Guide): void;
}

/** 캐릭터 하나를 세운다 (glb 를 읽어 오므로 기다려야 한다). url 을 주면 그 주소에서 읽는다 (내보낸 파일은 data: 주소) */
export async function buildGuide(g: Guide, url?: string): Promise<GuideModel> {
  const spec = specOf(g.who);
  const asset: DollAsset = await loadDoll(url ?? spec.file);
  const group = new THREE.Group();
  const doll = asset.scene;                    // loadDoll 이 이미 새 복사본을 준다
  applyLook(doll, undefined, spec);
  group.add(doll);
  group.name = "guide";
  const mixer = new THREE.AnimationMixer(doll);
  let clip: THREE.AnimationAction | null = null;

  const place = (next: Guide): void => {
    group.position.copy(toThree(next.x, next.y));
    group.rotation.y = rad(next.rot);
    const found = asset.animations.find((a) => a.name === next.pose) ?? asset.animations[0];
    if (found && clip?.getClip() !== found) {
      clip?.stop();
      clip = mixer.clipAction(found);
      clip.reset().play();
    }
  };
  place(g);
  return { group, update: (dt) => mixer.update(dt), place };
}
