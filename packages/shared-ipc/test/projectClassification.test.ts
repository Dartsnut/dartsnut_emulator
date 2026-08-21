import { describe, expect, it } from "vitest";
import { classifyDartsnutProjectFiles } from "../src/projectClassification";

const pyproject = (dependency = "pydartsnut==1.2.1") => `
[project]
name = "demo"
version = "1.2.3"
dependencies = [${JSON.stringify(dependency)}]
`;

describe("classifyDartsnutProjectFiles", () => {
  it("rejects missing and malformed pyproject.toml", () => {
    expect(classifyDartsnutProjectFiles(null, null)).toMatchObject({ ok: false, reason: "missing_pyproject" });
    expect(classifyDartsnutProjectFiles("[project", null)).toMatchObject({ ok: false, reason: "invalid_pyproject" });
  });

  it("requires project name, version, and string dependencies", () => {
    expect(classifyDartsnutProjectFiles('[project]\nversion="1"\ndependencies=["pydartsnut"]', null))
      .toMatchObject({ ok: false, reason: "missing_project_name" });
    expect(classifyDartsnutProjectFiles('[project]\nname="demo"\ndependencies=["pydartsnut"]', null))
      .toMatchObject({ ok: false, reason: "missing_project_version" });
    expect(classifyDartsnutProjectFiles('[project]\nname="demo"\nversion="1"\ndependencies="pydartsnut"', null))
      .toMatchObject({ ok: false, reason: "invalid_pyproject" });
  });

  it("requires a normalized direct pydartsnut dependency", () => {
    expect(classifyDartsnutProjectFiles(pyproject("requests"), null))
      .toMatchObject({ ok: false, reason: "missing_pydartsnut" });
    for (const dependency of ["pydartsnut", "PyDartsNut>=1", "py_dartsnut[extra] ~= 1.2; python_version >= '3.11'"]) {
      expect(classifyDartsnutProjectFiles(pyproject(dependency), null)).toMatchObject({ ok: true, projectType: "game" });
    }
  });

  it("classifies a project without conf.json as a game", () => {
    expect(classifyDartsnutProjectFiles(pyproject(), null)).toMatchObject({
      ok: true,
      appId: "demo",
      version: "1.2.3",
      projectType: "game",
      conf: null
    });
  });

  it("classifies a legacy type=game conf.json as a game", () => {
    expect(
      classifyDartsnutProjectFiles(
        pyproject(),
        '{"type":"game","size":[128,160],"fields":[]}'
      )
    ).toMatchObject({
      ok: true,
      appId: "demo",
      version: "1.2.3",
      projectType: "game",
      conf: null
    });
  });

  it("classifies conf.json by size and fields key presence", () => {
    expect(classifyDartsnutProjectFiles(pyproject(), '{"size":null,"fields":null}')).toMatchObject({
      ok: true,
      projectType: "widget"
    });
    for (const conf of ["{", "[]", "{}", '{"size":[128,128]}', '{"fields":[]}']) {
      expect(classifyDartsnutProjectFiles(pyproject(), conf)).toMatchObject({ ok: false, reason: "broken_widget" });
    }
  });
});
