/**
 * RangeCirclePass — draws a translucent circle showing the effective
 * range of a structure during build-mode ghost preview. White by default,
 * red when the ghost flags a warning (e.g. nuking would break an alliance).
 *
 * Single quad with circle SDF in the fragment shader.
 * Active only when a ghost preview with rangeRadius > 0 is set.
 */

import type {
  AvoidedTilesData,
  DefenseLinePreviewData,
  GhostPreviewData,
} from "../../types";
import { createProgram } from "../utils/GlUtils";

import fragSrc from "../shaders/range-circle/range-circle.frag.glsl?raw";
import vertSrc from "../shaders/range-circle/range-circle.vert.glsl?raw";

/** Marker radius for a frontline tile excluded from conquest (in tiles). */
const AVOIDED_TILE_RADIUS = 0.5;

/** One Tollhouse interception range, drawn persistently for every player. */
export interface TollhouseRangeCircle {
  x: number;
  y: number;
  radius: number;
  friendly: boolean;
}

// Tollhouse range colors: amber for self/allies, red for everyone else.
const TOLLHOUSE_FRIENDLY_COLOR: [number, number, number] = [1.0, 0.85, 0.2];
const TOLLHOUSE_ENEMY_COLOR: [number, number, number] = [1.0, 0.25, 0.25];

export class RangeCirclePass {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;

  private uCamera: WebGLUniformLocation;
  private uCenter: WebGLUniformLocation;
  private uRadius: WebGLUniformLocation;
  private uColor: WebGLUniformLocation;

  private centerX = 0;
  private centerY = 0;
  private radius = 0;
  private warning = false;

  // Defense-post line preview circles (overrides the single ghost circle).
  private line: DefenseLinePreviewData | null = null;

  // Avoided (excluded-from-conquest) frontline tile markers.
  private avoided: AvoidedTilesData | null = null;

  // Persistent Tollhouse interception ranges (all players' Tollhouses).
  private tollhouses: readonly TollhouseRangeCircle[] = [];

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, vertSrc, fragSrc);

    this.uCamera = gl.getUniformLocation(this.program, "uCamera")!;
    this.uCenter = gl.getUniformLocation(this.program, "uCenter")!;
    this.uRadius = gl.getUniformLocation(this.program, "uRadius")!;
    this.uColor = gl.getUniformLocation(this.program, "uColor")!;

    // Unit quad [0,1]
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  updateGhostPreview(data: GhostPreviewData | null): void {
    if (data && data.rangeRadius > 0) {
      this.centerX = data.radiusTileX;
      this.centerY = data.radiusTileY;
      this.radius = data.rangeRadius;
      this.warning = data.rangeWarning;
    } else {
      this.radius = 0;
      this.warning = false;
    }
  }

  /** Set (or clear, with null) the defense-post line preview circles. */
  updateDefenseLine(data: DefenseLinePreviewData | null): void {
    this.line = data;
  }

  /** Set (or clear, with null) the avoided-conquest tile markers. */
  updateAvoidedTiles(data: AvoidedTilesData | null): void {
    this.avoided = data;
  }

  /**
   * Set the persistent Tollhouse ranges. Every player's Tollhouses are shown
   * so a passing trade ship can see where it will be taxed.
   */
  updateTollhouseRanges(data: readonly TollhouseRangeCircle[] | null): void {
    this.tollhouses = data ?? [];
  }

  draw(cameraMatrix: Float32Array): void {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniformMatrix3fv(this.uCamera, false, cameraMatrix);
    gl.bindVertexArray(this.vao);

    // Persistent Tollhouse ranges (drawn under the transient ghost overlays).
    for (const t of this.tollhouses) {
      if (t.radius <= 0) continue;
      gl.uniform2f(this.uCenter, t.x, t.y);
      gl.uniform1f(this.uRadius, t.radius);
      const color = t.friendly
        ? TOLLHOUSE_FRIENDLY_COLOR
        : TOLLHOUSE_ENEMY_COLOR;
      gl.uniform3f(this.uColor, color[0], color[1], color[2]);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    // Defense-post line preview takes priority over the single ghost circle.
    if (this.line !== null) {
      const { centers, radius } = this.line;
      if (radius > 0 && centers.length > 0) {
        gl.uniform1f(this.uRadius, radius);
        gl.uniform3f(this.uColor, 1.0, 1.0, 1.0);
        for (const c of centers) {
          gl.uniform2f(this.uCenter, c.x, c.y);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
      }
    } else if (this.radius > 0) {
      gl.uniform2f(this.uCenter, this.centerX, this.centerY);
      gl.uniform1f(this.uRadius, this.radius);
      if (this.warning) {
        gl.uniform3f(this.uColor, 1.0, 0.2, 0.2);
      } else {
        gl.uniform3f(this.uColor, 1.0, 1.0, 1.0);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    // Avoided conquest tiles — orange markers drawn last so they sit on top.
    if (this.avoided !== null && this.avoided.tiles.length > 0) {
      gl.uniform1f(this.uRadius, AVOIDED_TILE_RADIUS);
      gl.uniform3f(this.uColor, 1.0, 0.4, 0.1);
      for (const t of this.avoided.tiles) {
        gl.uniform2f(this.uCenter, t.x, t.y);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    }
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
  }
}
