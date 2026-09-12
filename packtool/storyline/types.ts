// Document schema for Storyline extract output (issue #77, G5).
//
// One SlideDoc per content slide (scenes >= 1, non-message), plus one
// OutlineDoc per publish folder. Field order in this file mirrors the
// serialization order pinned by the golden fixture files
// (tests/fixtures/storyline-mini/expected/).

export type TranscriptSource = 'sidecar' | 'missing' | 'none';

export interface SpineEntry {
  slideId: string;
  slideTitle: string;
  sceneNumber: number;
  slideNumberInScene: number;
  html5url: string;
  sectionTitle: string;
}

export interface SlideDoc {
  course: string;
  scene_number: number;
  section_title: string;
  slide_number_in_scene: number;
  slide_id: string;
  slide_title: string;
  on_screen_text: string;
  text_chars: number;
  transcript_source: TranscriptSource;
  transcript_text?: string;
  // D2 (#78) placeholder: populated here when a sidecar exists; D2 owns
  // narration for slides whose media is untranscribed.
  narration_ref?: string;
  provenance: string;
  source_files: string[];
  html5url: string;
}

export interface OutlineSection {
  title: string;
  slide_count: number;
}

export interface OutlineDoc {
  course: string;
  duration: string;
  scene_count: number;
  sections: OutlineSection[];
}
