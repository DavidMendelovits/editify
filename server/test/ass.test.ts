import { describe, expect, it } from 'vitest';
import type { Project } from '@editify/shared';
import { generateAss } from '../src/media/ass.js';

describe('ASS subtitle generation', () => {
  it('serializes caption timing, placement margins, and dialogue text', () => {
    const project: Project = {
      id: 'ass-project', title: 'ASS test', format: '9:16', fps: 30, duration: 4, version: 0,
      tracks: [{
        id: 'captions', kind: 'caption', clips: [
          { id: 'cap-1', start: 1.23, in: 0, out: 2.22, text: 'KEEP IT, MOVING', style: {
            font: 'Montserrat', size: 64, color: '#FFFFFF', position: 'center', emphasis: 'highlight',
            anchorPct: 62, sizePct: 7.2, strokeColor: '#000000', strokePx: 6,
            emphasisColor: '#FACC15', words: [
              { w: 'KEEP', s: 1.23, e: 1.63 }, { w: 'IT,', s: 1.63, e: 1.83 }, { w: 'MOVING', s: 1.83, e: 2.45 },
            ],
          } },
          { id: 'cap-2', start: 0, in: 0, out: 0.5, text: 'TOP', style: {
            font: 'Montserrat', size: 52, color: '#FFFFFF', position: 'top', emphasis: 'bold',
          } },
        ],
      }],
    };
    expect(generateAss(project, 1080, 1920, { fontFamily: 'Montserrat', safeAreaBottomPct: 12 }))
      .toMatchInlineSnapshot(`
        "[Script Info]
        ScriptType: v4.00+
        WrapStyle: 0
        ScaledBorderAndShadow: yes
        PlayResX: 1080
        PlayResY: 1920

        [V4+ Styles]
        Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
        Style: Caption1,Montserrat,52,&H00FFFFFF,&H0015CCFA,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,3,1,8,40,40,230,1
        Style: Caption2,Montserrat,138,&H00FFFFFF,&H0015CCFA,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,6,1,5,40,40,0,1

        [Events]
        Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
        Dialogue: 0,0:00:00.00,0:00:00.50,Caption1,,0,0,0,,TOP
        Dialogue: 0,0:00:01.23,0:00:03.45,Caption2,,0,0,0,,{\\pos(540,1190)}{\\k40}KEEP {\\k20}IT, {\\k62}MOVING
        "
      `);
  });
});
