import * as THREE from "three";

/**
 * 입 모양 고르기. 인형(doll.glb)에 입 모양 조각이 여러 개 들어 있고(tools/blender/doll_mouth.py 가 만든다)
 * 그중 하나만 보이게 해서 표정을 바꾼다. 원래 인형의 파인 입 홈은 내보낼 때 펴 두었다.
 */
export type MouthShape =
  | "smile" | "grin" | "open" | "o" | "line"      // 기본·웃음·말하기·놀람·다문
  | "pout" | "wavy" | "bent" | "grim" | "frown" | "cry";   // 삐죽·난감·고민(꺾인 선)·꾹 다문·시무룩·울상

/** 조각 이름 (Mouth_<이름>, 혀가 있으면 Mouth_<이름>_Tongue) */
const PART: Record<MouthShape, string> = {
  smile: "Smile", grin: "Grin", open: "Open", o: "O", line: "Line",
  pout: "Pout", wavy: "Wavy", bent: "Bent", grim: "Grim", frown: "Frown", cry: "Cry",
};

export class Mouth {
  private parts = new Map<MouthShape, THREE.Object3D[]>();
  private current: MouthShape | null = null;

  constructor(root: THREE.Object3D) {
    for (const [shape, name] of Object.entries(PART) as [MouthShape, string][]) {
      const found = [root.getObjectByName(`Mouth_${name}`), root.getObjectByName(`Mouth_${name}_Tongue`)]
        .filter((o): o is THREE.Object3D => !!o);
      if (found.length) this.parts.set(shape, found);
    }
    for (const list of this.parts.values()) for (const o of list) o.visible = false;
  }

  get ready(): boolean { return this.parts.size > 0; }

  set(shape: MouthShape): void {
    if (shape === this.current) return;
    this.current = shape;
    for (const [kind, list] of this.parts) for (const o of list) o.visible = kind === shape;
  }
}
