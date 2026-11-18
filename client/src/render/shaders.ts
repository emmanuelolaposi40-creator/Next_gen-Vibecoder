export const FULLSCREEN_VERT = `#version 300 es
precision highp float;

out vec2 vUv;

void main() {
  // Fullscreen triangle
  float x = float((gl_VertexID & 1) << 2) - 1.0;
  float y = float((gl_VertexID & 2) << 1) - 1.0;
  vUv = vec2(x * 0.5 + 0.5, y * 0.5 + 0.5);
  gl_Position = vec4(x, y, 0.0, 1.0);
}
`;

export const WORLD_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;

uniform sampler2D uTerrainTex;
uniform mat4 uInvViewProj;
uniform mat4 uViewProj;
uniform vec3 uCamPos;
uniform float uTime;
uniform float uWorldSize;
uniform float uHeightScale;
uniform float uWaterLevel;

// Weather / lighting uniforms
uniform vec3 uSunDir;
uniform vec3 uSunDiscColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uHazeWarm;
uniform vec3 uHazeCool;
uniform float uCloudDensity;
uniform float uSnowLine;

// Dynamic aircraft shadow & scorch marks
uniform vec3 uJetPos;
// x, z, radius, age (0..1, 0 = inactive)
uniform vec4 uImpacts[8];

layout(location = 0) out vec4 outColor;

// Hash & 2D noise for clouds, water glints, and sky streaks
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbmCloud(vec2 p) {
  float v = 0.0;
  float a = 0.55;
  for (int i = 0; i < 4; i++) {
    v += a * noise2(p);
    p = p * 2.03 + vec2(17.1, 31.7);
    a *= 0.5;
  }
  return v;
}

vec4 sampleTerrain(vec2 xz) {
  vec2 uv = fract(xz / uWorldSize);
  return texture(uTerrainTex, uv);
}

float terrainWorldHeight(vec2 xz) {
  float hNorm = sampleTerrain(xz).r;
  return max(hNorm, uWaterLevel) * uHeightScale;
}

// Cloud density at world XZ
float cloudDensityAt(vec2 xz) {
  vec2 p = xz * 0.0022 + vec2(uTime * 0.0045, uTime * 0.0018);
  float n = fbmCloud(p);
  return smoothstep(1.0 - uCloudDensity, 1.0 - uCloudDensity + 0.28, n);
}

// Sky color for a given ray direction
vec3 evalSky(vec3 rd) {
  float y = clamp(rd.y, 0.0, 1.0);
  // Stepped sky gradient
  float band = floor(pow(y, 0.62) * 8.0) / 8.0;
  vec3 sky = mix(uSkyHorizon, uSkyZenith, band);

  // Warm-to-cool directional horizon glow
  float sunAlign = max(dot(normalize(vec3(rd.x, 0.0, rd.z)), normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0);
  vec3 horTint = mix(uHazeCool, uHazeWarm, pow(sunAlign, 1.6));
  sky = mix(sky, horTint, (1.0 - smoothstep(0.0, 0.32, y)) * 0.65);

  // High-altitude thin cloud streaks
  if (rd.y > 0.03) {
    vec2 skyUv = rd.xz / (rd.y + 0.14);
    float streak = noise2(vec2(skyUv.x * 1.4 + uTime * 0.008, skyUv.y * 7.5));
    float streakMask = smoothstep(0.64, 0.82, streak) * smoothstep(0.03, 0.22, rd.y) * (1.0 - smoothstep(0.35, 0.7, rd.y));
    vec3 streakCol = mix(uHazeCool * 1.15, uSunDiscColor, sunAlign * 0.7 + 0.2);
    sky = mix(sky, streakCol, streakMask * 0.45);
  }

  // Large low sun disc
  float sunDot = dot(rd, uSunDir);
  if (sunDot > 0.9945) {
    sky = uSunDiscColor * 1.18;
  } else if (sunDot > 0.986) {
    sky = mix(sky, uSunDiscColor, 0.45);
  }

  return sky;
}

float writeDepth(vec3 worldPos) {
  vec4 clip = uViewProj * vec4(worldPos, 1.0);
  float ndcZ = clip.z / clip.w;
  return clamp(ndcZ * 0.5 + 0.5, 0.0, 0.99998);
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 nearP = uInvViewProj * vec4(ndc, -1.0, 1.0);
  vec4 farP = uInvViewProj * vec4(ndc, 1.0, 1.0);
  vec3 ro = uCamPos;
  vec3 rd = normalize(farP.xyz / farP.w - nearP.xyz / nearP.w);

  float waterY = uWaterLevel * uHeightScale;
  float cloudBaseY = 128.0;
  float cloudTopY = 148.0;

  float maxDist = 1450.0;
  float t = 0.5;
  bool hitTerrain = false;
  vec3 hitPos = vec3(0.0);

  // Ray-march terrain/water (skip if camera is above max terrain and ray points upward)
  if (!(ro.y > uHeightScale + 2.0 && rd.y > 0.02)) {
    for (int i = 0; i < 72; i++) {
      vec3 p = ro + rd * t;
      float h = terrainWorldHeight(p.xz);
      if (p.y <= h) {
        // Binary refine 3 steps
        float tLo = t - max(1.5, t * 0.05);
        float tHi = t;
        for (int b = 0; b < 3; b++) {
          float tMid = 0.5 * (tLo + tHi);
          vec3 pm = ro + rd * tMid;
          if (pm.y <= terrainWorldHeight(pm.xz)) {
            tHi = tMid;
          } else {
            tLo = tMid;
          }
        }
        t = tHi;
        hitPos = ro + rd * t;
        hitTerrain = true;
        break;
      }
      if (t > maxDist || (p.y > uHeightScale + 4.0 && rd.y > 0.02)) break;
      // Adaptive step size
      float clearance = max(1.2, p.y - h);
      t += clamp(clearance * 0.44, 1.8, 28.0) + t * 0.02;
    }
  }

  vec3 col = evalSky(rd);
  float finalDepth = 0.99998;

  if (hitTerrain) {
    finalDepth = writeDepth(hitPos);
    vec4 data = sampleTerrain(hitPos.xz);
    float rawH = data.r;
    float bakedShadow = data.g;
    float forest = data.b;
    float detail = data.a;

    // Cloud shadow projected onto terrain along sun direction
    vec2 cloudShadowXZ = hitPos.xz + uSunDir.xz * ((cloudBaseY - hitPos.y) / max(uSunDir.y, 0.12));
    float cShad = cloudDensityAt(cloudShadowXZ);

    // Dynamic aircraft shadow on terrain
    vec2 jetShadowXZ = uJetPos.xz - uSunDir.xz * ((uJetPos.y - hitPos.y) / max(uSunDir.y, 0.12));
    float jetDist = length(hitPos.xz - jetShadowXZ);
    float jetShadow = smoothstep(4.5, 2.2, jetDist);

    float light = bakedShadow * (1.0 - cShad * 0.58) * (1.0 - jetShadow * 0.55);

    if (rawH <= uWaterLevel + 0.004) {
      // WATER SHADING
      float depth = clamp((uWaterLevel - rawH) / max(uWaterLevel, 0.001), 0.0, 1.0);
      // Distinct depth bands: pale turquoise shallows -> deep navy
      vec3 shallowCol = vec3(0.36, 0.64, 0.64);
      vec3 midCol = vec3(0.16, 0.34, 0.48);
      vec3 deepCol = vec3(0.08, 0.14, 0.28);
      vec3 wCol = depth < 0.22 ? shallowCol : (depth < 0.52 ? midCol : deepCol);

      // Animated shoreline foam
      float foamWave = sin(depth * 42.0 - uTime * 3.4 + detail * 6.0);
      if (depth < 0.065 && foamWave > 0.25) {
        wCol = vec3(0.92, 0.89, 0.84);
      }

      // Low-angle sky reflection
      vec3 reflRd = reflect(rd, normalize(vec3((detail - 0.5) * 0.06, 1.0, (forest - 0.5) * 0.06)));
      float fresnel = pow(1.0 - max(-rd.y, 0.0), 3.0);
      vec3 skyRefl = evalSky(vec3(reflRd.x, abs(reflRd.y), reflRd.z));
      wCol = mix(wCol, skyRefl, fresnel * 0.55);

      // Shimmering sun glitter path + short crisp white glints
      vec2 waveCell = floor(hitPos.xz * 0.9 + vec2(uTime * 1.3, -uTime * 0.9));
      float glintNoise = hash21(waveCell);
      float sunGlitter = pow(max(dot(reflRd, uSunDir), 0.0), 28.0);
      if (sunGlitter > 0.18 && glintNoise > 0.62) {
        wCol = uSunDiscColor * 1.1;
      } else if (glintNoise > 0.965 && length(hitPos.xz - uCamPos.xz) < 420.0) {
        wCol = vec3(0.95, 0.92, 0.88);
      }

      // Apply cloud & mountain shadows onto water
      wCol *= mix(0.55, 1.0, light);
      col = wCol;
    } else {
      // LAND BIOMES
      float eps = 2.6;
      float hL = terrainWorldHeight(hitPos.xz - vec2(eps, 0.0));
      float hR = terrainWorldHeight(hitPos.xz + vec2(eps, 0.0));
      float hD = terrainWorldHeight(hitPos.xz - vec2(0.0, eps));
      float hU = terrainWorldHeight(hitPos.xz + vec2(0.0, eps));
      vec3 normal = normalize(vec3(hL - hR, eps * 2.0, hD - hU));
      float slope = 1.0 - normal.y;

      float elev = (rawH - uWaterLevel) / (1.0 - uWaterLevel);
      // Subtle terraced elevation shading
      float terrace = floor(elev * 14.0) / 14.0;

      vec3 sandCol = vec3(0.76, 0.64, 0.48);
      vec3 meadowCol = vec3(0.66, 0.58, 0.36);
      vec3 orangeForest = vec3(0.74, 0.36, 0.18);
      vec3 crimsonForest = vec3(0.62, 0.21, 0.22);
      vec3 goldForest = vec3(0.82, 0.61, 0.22);
      vec3 coniferCol = vec3(0.16, 0.26, 0.20);
      vec3 rockCol = vec3(0.42, 0.36, 0.46);
      vec3 snowCol = vec3(0.92, 0.89, 0.94);

      vec3 landCol = meadowCol;
      if (elev < 0.045) {
        landCol = sandCol;
      } else if (rawH > uSnowLine && slope < 0.38) {
        landCol = snowCol;
      } else if (slope > 0.26 || elev > 0.58) {
        landCol = mix(rockCol, rockCol * 0.82, terrace);
      } else {
        // Forest patches vs autumn meadows
        if (forest > 0.50) {
          float treeType = hash21(floor(hitPos.xz * 0.45));
          if (treeType < 0.30) landCol = orangeForest;
          else if (treeType < 0.54) landCol = crimsonForest;
          else if (treeType < 0.74) landCol = goldForest;
          else landCol = coniferCol;
        } else {
          landCol = mix(meadowCol, meadowCol * 0.88, terrace);
        }
      }

      // Stepped directional sun + violet ambient shadow
      float ndl = max(dot(normal, uSunDir), 0.0);
      float diffuse = ndl * light;
      float steppedLight = diffuse > 0.45 ? 1.0 : (diffuse > 0.14 ? 0.65 : 0.34);
      vec3 shadowTint = vec3(0.32, 0.24, 0.46); // deep violet shadow
      vec3 sunTint = mix(vec3(1.0), uHazeWarm, 0.25);
      col = landCol * mix(shadowTint, sunTint, steppedLight);
    }

    // Impact scorch marks / expanding water foam rings
    for (int i = 0; i < 8; i++) {
      vec4 imp = uImpacts[i];
      if (imp.w > 0.001) {
        float d = length(hitPos.xz - imp.xy);
        if (rawH <= uWaterLevel + 0.004) {
          // Expanding foam ring on water
          float ringR = (1.0 - imp.w) * 28.0 + 3.0;
          if (abs(d - ringR) < 1.6 && imp.w > 0.1) {
            col = mix(col, vec3(0.95, 0.94, 0.92), imp.w);
          }
        } else {
          // Glowing ember scorch mark on land
          if (d < imp.z) {
            float core = 1.0 - d / imp.z;
            vec3 ember = mix(vec3(0.14, 0.10, 0.12), vec3(0.96, 0.42, 0.16), core * imp.w);
            col = ember;
          }
        }
      }
    }

    // Atmospheric horizon haze (warm gold toward sun, cool lilac away)
    float distFactor = smoothstep(140.0, maxDist * 0.92, t);
    float sunAlign = max(dot(normalize(vec3(rd.x, 0.0, rd.z)), normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0);
    vec3 hazeCol = mix(uHazeCool, uHazeWarm, pow(sunAlign, 1.4));
    col = mix(col, hazeCol, distFactor * 0.85);
  }

  // Puffy cumulus cloud layer below cruise altitude
  // Check ray intersection with cloud slab [cloudBaseY, cloudTopY]
  if (abs(rd.y) > 0.005) {
    float t0 = (cloudBaseY - ro.y) / rd.y;
    float t1 = (cloudTopY - ro.y) / rd.y;
    float tEnter = min(t0, t1);
    float tExit = max(t0, t1);
    float terrainT = hitTerrain ? t : maxDist;

    if (tExit > 0.0 && tEnter < terrainT && tEnter < maxDist * 0.88) {
      float tCloud = max(tEnter, 1.0);
      vec3 cPos = ro + rd * tCloud;
      float cDens = cloudDensityAt(cPos.xz);
      if (cDens > 0.18) {
        // Stepped pixel cloud shading
        vec3 cloudLit = mix(uHazeWarm * 1.05, uSunDiscColor, 0.35);
        vec3 cloudShade = mix(uHazeCool * 0.85, vec3(0.38, 0.30, 0.50), 0.35);
        float puff = smoothstep(0.18, 0.72, cDens);
        float cStep = puff > 0.55 ? 1.0 : (puff > 0.32 ? 0.6 : 0.25);

        // Dynamic aircraft shadow on cloud tops when jet is above clouds
        if (uJetPos.y > cloudTopY) {
          vec2 jetCloudShadow = uJetPos.xz - uSunDir.xz * ((uJetPos.y - cloudTopY) / max(uSunDir.y, 0.15));
          if (length(cPos.xz - jetCloudShadow) < 5.0) {
            cStep *= 0.45;
          }
        }

        vec3 cCol = mix(cloudShade, cloudLit, cStep);
        float cDistFade = 1.0 - smoothstep(450.0, maxDist * 0.88, tCloud);
        float alpha = smoothstep(0.18, 0.42, cDens) * cDistFade;
        col = mix(col, cCol, alpha);
        if (alpha > 0.75) {
          finalDepth = min(finalDepth, writeDepth(cPos));
        }
      }
    }
  }

  gl_FragDepth = finalDepth;
  outColor = vec4(col, 1.0);
}
`;

export const MESH_VERT = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec3 aColor;

uniform mat4 uModel;
uniform mat4 uViewProj;

out vec3 vNormal;
out vec3 vColor;
out vec3 vWorldPos;

void main() {
  vec4 wp = uModel * vec4(aPos, 1.0);
  vWorldPos = wp.xyz;
  vNormal = mat3(uModel) * aNormal;
  vColor = aColor;
  gl_Position = uViewProj * wp;
}
`;

export const MESH_FRAG = `#version 300 es
precision highp float;

in vec3 vNormal;
in vec3 vColor;
in vec3 vWorldPos;

uniform vec3 uSunDir;
uniform float uUnlit;

layout(location = 0) out vec4 outColor;

void main() {
  if (uUnlit > 0.5) {
    outColor = vec4(vColor, 1.0);
    return;
  }
  vec3 n = normalize(vNormal);
  float ndl = dot(n, uSunDir);
  // Flat-shaded in 3 distinct tone steps
  float shade = ndl > 0.35 ? 1.12 : (ndl > -0.15 ? 0.78 : 0.46);
  vec3 lit = vColor * shade;
  if (shade < 0.5) {
    lit = mix(lit, vec3(0.24, 0.18, 0.36), 0.25);
  }
  outColor = vec4(lit, 1.0);
}
`;

export const BLIT_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;

uniform sampler2D uColorTex;
uniform sampler2D uDepthTex;
uniform vec2 uResolution;
uniform float uOutlineStrength;

out vec4 fragColor;

// 4x4 Bayer ordered dithering matrix
float bayer4x4(ivec2 p) {
  int x = p.x & 3;
  int y = p.y & 3;
  int idx = y * 4 + x;
  const float m[16] = float[16](
     0.0/16.0,  8.0/16.0,  2.0/16.0, 10.0/16.0,
    12.0/16.0,  4.0/16.0, 14.0/16.0,  6.0/16.0,
     3.0/16.0, 11.0/16.0,  1.0/16.0,  9.0/16.0,
    15.0/16.0,  7.0/16.0, 13.0/16.0,  5.0/16.0
  );
  return m[idx] - 0.5;
}

void main() {
  ivec2 px = ivec2(floor(vUv * uResolution));
  vec3 col = texelFetch(uColorTex, px, 0).rgb;
  float d = texelFetch(uDepthTex, px, 0).r;

  // 1-pixel dark outline on close foreground silhouettes (aircraft / missiles)
  if (uOutlineStrength > 0.5 && d < 0.995) {
    float dL = texelFetch(uDepthTex, px + ivec2(-1, 0), 0).r;
    float dR = texelFetch(uDepthTex, px + ivec2(1, 0), 0).r;
    float dU = texelFetch(uDepthTex, px + ivec2(0, 1), 0).r;
    float dD = texelFetch(uDepthTex, px + ivec2(0, -1), 0).r;
    float maxJump = max(max(dL - d, dR - d), max(dU - d, dD - d));
    if (maxJump > 0.004) {
      col = vec3(0.08, 0.06, 0.14);
    }
  }

  // Ordered 4x4 Bayer dithering + limited palette quantization
  float dither = bayer4x4(px) * 0.075;
  vec3 quant = floor(clamp(col + dither, 0.0, 1.0) * vec3(11.0, 11.0, 10.0) + 0.5) / vec3(11.0, 11.0, 10.0);

  fragColor = vec4(quant, 1.0);
}
`;
