import { describe, expect, it } from "vite-plus/test";

import { EMPTY_USAGE_EXTRA_DRAFT, usageExtraFromDraft } from "./usageExtras.logic";

const now = new Date(2026, 9, 20, 12, 0).getTime();
const draft = { ...EMPTY_USAGE_EXTRA_DRAFT, service: " Higgsfield ", title: "AI Influencer free" };

describe("usageExtraFromDraft", () => {
  it("lasts through the end of the chosen day", () => {
    const extra = usageExtraFromDraft({ ...draft, endsOn: "2026-11-02", remaining: "4" }, now);
    expect(extra).toEqual({
      service: "Higgsfield",
      title: "AI Influencer free",
      remaining: 4,
      expiresAt: new Date(2026, 10, 2, 23, 59, 59, 999).toISOString(),
    });
    // Ending today is still ahead until midnight.
    expect(usageExtraFromDraft({ ...draft, endsOn: "2026-10-20" }, now)).not.toBeNull();
  });

  it("leaves the count out for unlimited perks and refuses incomplete drafts", () => {
    expect(usageExtraFromDraft({ ...draft, endsOn: "2026-11-02" }, now)).not.toHaveProperty(
      "remaining",
    );
    expect(usageExtraFromDraft({ ...draft, endsOn: "" }, now)).toBeNull();
    expect(usageExtraFromDraft({ ...draft, endsOn: "2026-10-19" }, now)).toBeNull();
    expect(
      usageExtraFromDraft({ ...draft, endsOn: "2026-11-02", remaining: "2.5" }, now),
    ).toBeNull();
    expect(usageExtraFromDraft({ ...draft, title: " ", endsOn: "2026-11-02" }, now)).toBeNull();
  });
});
