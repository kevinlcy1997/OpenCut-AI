import { expect, test } from "bun:test";
import { VisualNode, type VisualNodeParams } from "./visual-node";
class Probe extends VisualNode {
 source(time: number) { return this.getSourceLocalTime({time}); }
 visible(time: number) { return this.isInRange({time}); }
}
function node(rate: number) {
 return new Probe({ duration: 4, timeOffset: 10, trimStart: 2, trimEnd: 0, playbackRate: rate, opacity: 1, transform: { scale: 1, position: {x:0,y:0}, rotate:0 } } as VisualNodeParams);
}
test("fast video remains visible for its timeline duration", () => {
 const fast = node(2);
 expect(fast.visible(13)).toBe(true);
 expect(fast.source(13)).toBe(8);
 expect(fast.visible(14)).toBe(false);
});
test("slow video ends at its timeline boundary", () => {
 const slow = node(0.5);
 expect(slow.visible(9)).toBe(false);
 expect(slow.visible(13)).toBe(true);
 expect(slow.source(13)).toBe(3.5);
 expect(slow.visible(15)).toBe(false);
});
