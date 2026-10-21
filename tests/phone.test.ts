import { describe, expect, it } from "vitest";
import { checkPhone, phoneError } from "../lib/phone";

describe("phone numbers", () => {
  it("accepts a 10-digit mobile number and files it with the country code", () => {
    expect(checkPhone("9876543210")).toEqual({ ok: true, phone: "9876543210", phoneNormalized: "+919876543210" });
    expect(checkPhone(" 98765 43210 ")).toEqual({ ok: true, phone: "9876543210", phoneNormalized: "+919876543210" });
    expect(checkPhone("(98765) 43210")).toEqual({ ok: true, phone: "9876543210", phoneNormalized: "+919876543210" });
  });

  it("understands the +91, 91 and 0 people write in front, and stores ten digits either way", () => {
    for (const typed of ["+91 98765-43210", "9198765 43210", "098765 43210"]) {
      expect(checkPhone(typed)).toEqual({ ok: true, phone: "9876543210", phoneNormalized: "+919876543210" });
    }
  });

  it("keeps an empty number empty, because the field is optional on some forms", () => {
    expect(checkPhone("")).toEqual({ ok: true, phone: "", phoneNormalized: "" });
    expect(checkPhone("   ")).toEqual({ ok: true, phone: "", phoneNormalized: "" });
    expect(phoneError("")).toBe("");
  });

  it("rejects anything that is not ten digits once a known prefix is dropped", () => {
    expect(phoneError("98765")).toContain("10-digit");
    expect(phoneError("98765432100")).toContain("10-digit");
    expect(phoneError("+919876543210123")).toContain("10-digit");
  });

  it("rejects numbers from outside India", () => {
    expect(phoneError("+1 (415) 555-2671")).toContain("10-digit");
    expect(phoneError("+44 20 7946 0958")).toContain("10-digit");
  });

  it("rejects a 10-digit number that is not a mobile range", () => {
    expect(phoneError("1234567890")).toContain("6, 7, 8, or 9");
    expect(phoneError("5876543210")).toContain("6, 7, 8, or 9");
  });

  it("rejects letters and a misplaced plus", () => {
    expect(phoneError("98765abcde")).toContain("digits");
    expect(phoneError("+91+9876543210")).toContain("only at the start");
  });
});
