import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { extractApprovalTargets, parseApprovalLink } from "./daxiangApprovalLinks.ts";

it.effect("parses every supported approval link into a stable dedupe key", () =>
  Effect.sync(() => {
    const pr = parseApprovalLink(
      "https://dev.sankuai.com/code/repo-detail/group/repo/pr/123/diff?from=chat",
    );
    assert.deepStrictEqual(pr, {
      kind: "pr",
      key: "pr:group/repo#123",
      url: "https://dev.sankuai.com/code/repo-detail/group/repo/pr/123/diff",
      repository: "group/repo",
      number: 123,
    });
    assert.deepStrictEqual(
      parseApprovalLink("https://mcm.mws.sankuai.com/#/mine/plan/detail/456")?.kind,
      "mcm-plan",
    );
    assert.deepStrictEqual(
      parseApprovalLink("https://mcm.mws.sankuai.com/#/process-center/detail/789/info")?.kind,
      "mcm-event",
    );
    assert.deepStrictEqual(
      parseApprovalLink(
        "https://lion.mws.sankuai.com/transitions/audit?auditId=42&appKey=com.example.app",
      ),
      {
        kind: "lion",
        key: "lion:lion.mws.sankuai.com:42",
        url: "https://lion.mws.sankuai.com/transitions/audit?auditId=42&appKey=com.example.app",
        auditId: "42",
        appKey: "com.example.app",
      },
    );
    assert.deepStrictEqual(
      parseApprovalLink("https://rds.mws.sankuai.com/dba/mission_detail_appr/abc-def#current")
        ?.kind,
      "rds",
    );
    const dms = parseApprovalLink(
      "https://dms.mws.sankuai.com/mc/import_mission_detail/uuid-1?dagId=dml&missionType=mysql",
    );
    assert.deepStrictEqual(dms?.kind, "dms");
    assert.deepStrictEqual(dms?.kind === "dms" ? dms.dagId : null, "dml");
    assert.isNull(parseApprovalLink("https://km.sankuai.com/collabpage/123"));
    assert.isNull(
      parseApprovalLink("https://dev.sankuai.com/code/repo-detail/group/repo/pr/not-a-number"),
    );
  }),
);

it.effect("extracts approval links from text, cards and quoted messages without duplicates", () =>
  Effect.sync(() => {
    const event = {
      event: "message",
      text: "请审批 [[PR|https://dev.sankuai.com/code/repo-detail/group/repo/pr/123/diff]]，谢谢",
      body: {
        contentTitle: "MCM 审批",
        content: "https://mcm.mws.sankuai.com/#/mine/plan/detail/456",
        link: "https://lion.mws.sankuai.com/transitions/audit?auditId=42&appKey=com.example.app",
      },
      extension: {
        quoted: [
          {
            text: "再次发送 https://dev.sankuai.com/code/repo-detail/group/repo/pr/123/diff",
          },
        ],
      },
    };
    const targets = extractApprovalTargets(event);
    assert.deepStrictEqual(
      targets.map((target) => target.key),
      ["pr:group/repo#123", "mcm-plan:mcm.mws.sankuai.com:456", "lion:lion.mws.sankuai.com:42"],
    );
  }),
);
