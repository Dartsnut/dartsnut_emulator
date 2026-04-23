import { describe, expect, it } from "vitest";
import { validateProviderConfig } from "../src/providerConfig";
describe("validateProviderConfig", () => {
    it("fails when config fields are missing", () => {
        const result = validateProviderConfig({
            baseUrl: "",
            apiKey: "",
            model: ""
        });
        expect(result.ok).toBe(false);
    });
    it("passes when all fields exist", () => {
        const result = validateProviderConfig({
            baseUrl: "https://api.example.com/v1",
            apiKey: "sk-test",
            model: "gpt-test"
        });
        expect(result.ok).toBe(true);
    });
});
