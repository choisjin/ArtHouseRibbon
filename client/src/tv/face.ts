import * as THREE from "three";
import { Mouth, type MouthShape } from "./mouth";

/**
 * 리본이 표정. 인형 얼굴은 고정된 모양(눈·볼은 머리에 붙은 조각, 입은 머리에 뚫린 구멍)이라
 * 부품을 눌러 찌그러뜨리고 기울여 표정을 만든다. 입 모양은 바꿀 수 없다 (구멍이 고정).
 *
 * 각 부품을 제 가운데를 중심으로 돌리고 늘리려고, 부품마다 가운데에 축(pivot)을 하나 끼워 넣는다.
 */
export type Expression =
  | "normal" | "happy" | "surprised" | "sleepy" | "shy" | "curious" | "talking" | "thinking"
  | "sad" | "upset" | "worried" | "annoyed";      // 부정적인 표정들

interface EyeShape {
  /** 위아래로 누르기 (1 = 그대로, 0.1 = 실눈) */
  open: number;
  /** 좌우로 늘리기 */
  wide: number;
  /** 바깥쪽이 올라가면 +, 안쪽이 올라가면 - (웃는 눈 / 슬픈 눈) */
  slant: number;
  /** 위아래로 옮기기 (눈 크기 기준 비율) */
  lift: number;
}

interface Look {
  left: EyeShape;
  right: EyeShape;
  blush: number;      // 볼 크기 (1 = 그대로)
  blink: boolean;     // 눈을 깜빡이는가
  mouth: MouthShape;  // 입 모양 (mouth.ts)
  brow?: boolean;     // 미간 주름 (고민·언짢을 때)
}

const eye = (open = 1, wide = 1, slant = 0, lift = 0): EyeShape => ({ open, wide, slant, lift });
const both = (e: EyeShape, blush = 1, mouth: MouthShape = "open", blink = true): Look =>
  ({ left: e, right: { ...e }, blush, blink, mouth });

export const EXPRESSIONS: Record<Expression, Look> = {
  normal: both(eye(), 1, "smile"),                                   // 다물고 살짝 웃는 입
  happy: both(eye(0.34, 1.06, 0.34), 1.3, "grin"),                   // 웃는 눈 ^^ + 활짝
  surprised: both(eye(1.22, 1.12, 0, 0.04), 0.85, "o"),              // 눈 동그랗게 + 동그란 입
  sleepy: both(eye(0.42, 1, -0.06, -0.12), 1, "line"),               // 반쯤 감은 눈 + 다문 입
  shy: both(eye(0.55, 0.95, 0.2, -0.05), 1.75, "smile"),             // 볼 빨개짐
  sad: both(eye(0.78, 0.95, -0.3, -0.05), 1.1, "frown"),             // 눈꼬리·입꼬리 처짐
  upset: both(eye(0.62, 0.92, -0.42, -0.08), 1.35, "cry"),           // 울상 (많이 속상할 때)
  worried: both(eye(1.05, 0.98, -0.22, 0.02), 1, "wavy"),            // 걱정·난감
  annoyed: both(eye(0.5, 1.0, 0.26, -0.04), 1.05, "grim"),           // 뾰로통 (꾹 다문 입)
  curious: both(eye(1.1, 1.04, 0.08), 1.1, "o"),                     // 갸웃 (두 눈 같게)
  // 고민: 눈은 일자로 감고 미간에 주름, 입은 한쪽이 꺾인 선
  thinking: { left: eye(0.1, 1.06, 0), right: eye(0.1, 1.06, 0), blush: 1, blink: false, mouth: "bent", brow: true },
  talking: both(eye(0.9, 1.02, 0.12), 1.15, "open"),                 // 말할 때 (입을 크게 벌린 모양)
};

/** 부품 가운데에 축을 끼워 그 축을 돌리고 늘린다 */
function pivotFor(mesh: THREE.Object3D): THREE.Object3D | null {
  const parent = mesh.parent;
  if (!parent) return null;
  // 부품 상자(월드)와 부모의 월드→로컬 변환이 같은 행렬로 계산돼야 한다. 복제본은 행렬이 원본에서 복사된 채
  // 낡아 있을 수 있어서, 조상부터 부품까지 먼저 새로 계산한다 (안 그러면 축이 엉뚱한 곳에 생겨 눈이 떨어져 나간다)
  parent.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(mesh);
  const center = box.getCenter(new THREE.Vector3());
  parent.worldToLocal(center);
  const pivot = new THREE.Object3D();
  pivot.name = `${mesh.name}_pivot`;
  pivot.position.copy(center);
  parent.add(pivot);
  mesh.position.sub(center);
  pivot.add(mesh);
  return pivot;
}

export class Face {
  private mouth: Mouth | null = null;
  private eyes: { left: THREE.Object3D | null; right: THREE.Object3D | null } = { left: null, right: null };
  private baseY: { left: number; right: number } = { left: 0, right: 0 };
  private blush: THREE.Object3D[] = [];
  private brow: THREE.Object3D[] = [];
  private current: Look = EXPRESSIONS.normal;
  private shown: Record<"left" | "right", EyeShape> = { left: eye(), right: eye() };
  private blushNow = 1;
  private blinkTimer = 2;
  private blinkLeft = 0;

  constructor(root: THREE.Object3D) {
    const find = (name: string) => root.getObjectByName(name) ?? null;
    const mouth = new Mouth(root);
    this.mouth = mouth.ready ? mouth : null;
    const l = find("Eye_L"), r = find("Eye_R");
    this.eyes.left = l ? pivotFor(l) : null;
    this.eyes.right = r ? pivotFor(r) : null;
    this.baseY.left = this.eyes.left?.position.y ?? 0;
    this.baseY.right = this.eyes.right?.position.y ?? 0;
    for (const n of ["Furrow_L", "Furrow_R"]) {
      const m = find(n);
      if (m) { m.visible = false; this.brow.push(m); }
    }
    for (const n of ["Blush_L", "Blush_R"]) {
      const m = find(n);
      const p = m ? pivotFor(m) : null;
      if (p) this.blush.push(p);
    }
  }

  get ready(): boolean { return !!(this.eyes.left && this.eyes.right); }

  set(name: Expression): void {
    this.current = EXPRESSIONS[name] ?? EXPRESSIONS.normal;
    this.blinkLeft = 0;
    this.mouth?.set(this.current.mouth);
    for (const b of this.brow) b.visible = !!this.current.brow;
  }

  /** 지금 표정에서 눈만 잠깐 감기 */
  blink(): void { this.blinkLeft = 0.13; }

  /** 말하는 소리 크기(0~1). 말하는 표정일 때 입을 크게/작게 바꾼다 */
  setTalkLevel(v: number): void {
    if (this.current.mouth !== "open" && this.current.mouth !== "grin") return;
    this.mouth?.set(v > 0.28 ? "open" : "grin");
  }

  update(dt: number): void {
    if (!this.ready) return;
    // 깜빡임
    if (this.current.blink) {
      this.blinkTimer -= dt;
      if (this.blinkTimer <= 0) {
        this.blinkTimer = 2.5 + Math.random() * 4;
        this.blinkLeft = 0.13;
      }
    }
    if (this.blinkLeft > 0) this.blinkLeft -= dt;
    const closing = this.blinkLeft > 0 ? 1 : 0;

    const k = 1 - Math.exp(-dt * 12);
    for (const side of ["left", "right"] as const) {
      const pivot = this.eyes[side];
      if (!pivot) continue;
      const want = this.current[side];
      const s = this.shown[side];
      s.open += (Math.min(want.open, closing ? 0.08 : want.open) - s.open) * k;
      s.wide += (want.wide - s.wide) * k;
      s.slant += (want.slant - s.slant) * k;
      s.lift += (want.lift - s.lift) * k;
      pivot.scale.set(s.wide, Math.max(0.05, s.open), 1);
      pivot.rotation.z = s.slant * (side === "left" ? 1 : -1);
      pivot.position.y = this.baseY[side] + s.lift * 0.1;
    }
    this.blushNow += (this.current.blush - this.blushNow) * k;
    for (const b of this.blush) b.scale.setScalar(this.blushNow);
  }
}
