const {
  LINEAR_API_KEY,
  NOTION_API_KEY,
  NOTION_DATABASE_ID,
  TZ_OFFSET_HOURS = "9",
  OPENAI_API_KEY,
} = process.env;

if (!LINEAR_API_KEY || !NOTION_API_KEY || !NOTION_DATABASE_ID) {
  console.error("Missing envs");
  process.exit(1);
}

// 네 프로젝트 ID
const REBLOOM_PROJECT_ID = "96080a2d-9568-4992-8093-7a059aab1c3e";

function getKSTNow() {
  const now = new Date();
  return new Date(now.getTime() + Number(TZ_OFFSET_HOURS) * 60 * 60 * 1000);
}

// 어제 0시(KST) 기준으로 가져오게 계산
const kstNow = getKSTNow();
const kstYesterday = new Date(
  kstNow.getFullYear(),
  kstNow.getMonth(),
  kstNow.getDate() - 1,
  0, 0, 0
);
const yesterdayUTC = new Date(
  kstYesterday.getTime() - Number(TZ_OFFSET_HOURS) * 60 * 60 * 1000
);

const linearQuery = `
  query DailyIssues($updatedAfter: DateTimeOrDuration!, $projectId: ID!) {
    issues(
      filter: {
        project: { id: { eq: $projectId } }
        updatedAt: { gte: $updatedAfter }
      }
      orderBy: updatedAt
      first: 100
    ) {
      nodes {
        identifier
        title
        url
        state { name }
        assignee { name }
        description
        createdAt
        updatedAt
        completedAt
        dueDate
      }
    }
  }
`;

async function fetchLinear() {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": LINEAR_API_KEY,
    },
    body: JSON.stringify({
      query: linearQuery,
      variables: {
        updatedAfter: yesterdayUTC.toISOString(),
        projectId: REBLOOM_PROJECT_ID,
      },
    }),
  });
  if (!res.ok) {
    throw new Error("Linear error: " + (await res.text()));
  }
  const json = await res.json();
  return json.data.issues.nodes;
}

function classifyIssues(issues) {
  const kst = getKSTNow();
  const todayStr = kst.toISOString().slice(0, 10);
  const yesterday = new Date(
    kst.getFullYear(),
    kst.getMonth(),
    kst.getDate() - 1
  );

  const doneYesterday = [];
  const todayTargets = [];
  const remaining = [];

  for (const i of issues) {
    const state = i.state?.name ?? "Unknown";

    if (i.completedAt) {
      const comp = new Date(i.completedAt);
      const compKST = new Date(
        comp.getTime() + Number(TZ_OFFSET_HOURS) * 60 * 60 * 1000
      );
      const isYesterday =
        compKST.getFullYear() === yesterday.getFullYear() &&
        compKST.getMonth() === yesterday.getMonth() &&
        compKST.getDate() === yesterday.getDate();

      if (isYesterday) {
        doneYesterday.push(i);
        continue;
      }
    }

    if (i.dueDate === todayStr || state === "In Progress") {
      todayTargets.push(i);
      continue;
    }

    remaining.push(i);
  }

  return { doneYesterday, todayTargets, remaining };
}

async function makeDailyReportWithAI(issues, dateStr) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY missing");
  }

  const issueLinesForIssueSection = issues
    .map((i) => {
      const state = i.state?.name ?? "Unknown";
      const assignee = i.assignee?.name ? `, 담당: ${i.assignee.name}` : "";
      const desc = i.description
        ? `    설명: ${i.description.slice(0, 120)}...`
        : "";
      return [
        `- **${i.identifier}** ${i.title} (상태: ${state}${assignee})`,
        `  - ${i.url}`,
        desc,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");

  const { doneYesterday, todayTargets, remaining } = classifyIssues(issues);

  const doneText =
    doneYesterday
      .map((i) => {
        const who = i.assignee?.name ?? "담당자없음";
        return `- ${who}: ${i.title}`;
      })
      .join("\n") || "없음";

  const todayText =
    todayTargets
      .map((i) => {
        const who = i.assignee?.name ?? "담당자없음";
        return `- ${who}: ${i.title}`;
      })
      .join("\n") || "없음";

  const remainText =
  remaining.map(i => `- ${i.title}`).join("\n") || "없음";
  const remainBlock = "```r\n" + remainText + "\n```";

 const prompt = `
너는 게임 개발 팀의 일간보고를 작성하는 보조 AI야.
아래에 내가 실제로 분류해 놓은 리스트가 있으니까 **그것만** 써.
없는 사람은 "없음"이라고 반드시 써.
아무 작업도 추가로 만들어내지 마.

# ${dateStr} 일간보고: RE:BLOOM

---

# 전일 보고

## 완료
- 길하영:
\`\`\`r
${doneText
  .split("\n")
  .filter(l => l.includes("길하영:"))
  .map(l => l.replace("길하영: ", "- "))
  .join("\n") || "없음"}
\`\`\`
- 김주홍:
\`\`\`r
${doneText
  .split("\n")
  .filter(l => l.includes("김주홍:"))
  .map(l => l.replace("김주홍: ", "- "))
  .join("\n") || "없음"}
\`\`\`
- 이승연:
\`\`\`r
${doneText
  .split("\n")
  .filter(l => l.includes("이승연:"))
  .map(l => l.replace("이승연: ", "- "))
  .join("\n") || "없음"}
\`\`\`
- 기타:
\`\`\`r
${doneText
  .split("\n")
  .filter(l => !l.includes("길하영:") && !l.includes("김주홍:") && !l.includes("이승연:"))
  .join("\n") || "없음"}
\`\`\`

## 미완료 (사유, 처리)
- ${todayText === "없음" ? "없음" : todayText}

---

# 금일 보고

## 오전
- ${todayText === "없음" ? "없음" : todayText}
## 오후
- ${todayText === "없음" ? "없음" : todayText}
## (야근)
- 없음

---

# 남은 작업
\`\`\`r
{{REMAINING_TASKS}}
\`\`\`

[ISSUE_SECTION]
${issueLinesForIssueSection}
`.trim();

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "너는 팀 일간보고를 한국어로 예쁘게 작성하는 비서야.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.4,
    }),
  });

  if (!res.ok) {
    throw new Error("OpenAI error: " + (await res.text()));
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

// 이거 다시 넣어주자 – 이슈 섹션 말고는 DDK- 지워주는 후처리
function stripKeysOutsideIssue(content) {
  const lines = content.split("\n");
  let inIssue = false;

  return lines
    .map((line) => {
      const trimmed = line.trim();

      if (trimmed.startsWith("# 이슈")) {
        inIssue = true;
        return line;
      }
      if (trimmed.startsWith("# ") && !trimmed.startsWith("# 이슈")) {
        inIssue = false;
      }

      if (!inIssue && trimmed.startsWith("- DDK-")) {
        return line.replace(/- DDK-\d+\s*/i, "- ");
      }

      return line;
    })
    .join("\n");
}

async function createNotionPage(content) {
  const offset = parseInt(process.env.TZ_OFFSET_HOURS || "9", 10);
  const now = new Date();
  const kstNow = new Date(now.getTime() + offset * 60 * 60 * 1000);
  const yyyy = kstNow.getUTCFullYear();
  const mm = String(kstNow.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(kstNow.getUTCDate()).padStart(2, "0");
  const title = `Linear 일간보고 ${yyyy}-${mm}-${dd}`;

  const lines = content.split("\n");
  const children = [];
  let inCode = false;

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");

    // 코드블록 토글
    if (line.trim().startsWith("```")) {
      if (!inCode) {
        inCode = true;
        children.push({
          object: "block",
          type: "code",
          code: {
            rich_text: [],
            language: "plain text",
          },
        });
      } else {
        inCode = false;
      }
      continue;
    }

    if (inCode) {
      const last = children[children.length - 1];
      last.code.rich_text.push({
        type: "text",
        text: { content: line.slice(0, 2000) },
      });
      continue;
    }

    if (line.startsWith("# ")) {
      children.push({
        object: "block",
        type: "heading_1",
        heading_1: {
          rich_text: [{ type: "text", text: { content: line.slice(2) } }],
        },
      });
    } else if (line.startsWith("## ")) {
      children.push({
        object: "block",
        type: "heading_2",
        heading_2: {
          rich_text: [{ type: "text", text: { content: line.slice(3) } }],
        },
      });
    } else if (line.trim() === "---") {
      children.push({ object: "block", type: "divider", divider: {} });
    } else {
      children.push({
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [
            {
              type: "text",
              text: { content: line.slice(0, 2000) },
            },
          ],
        },
      });
    }
  }

  const limitedChildren = children.slice(0, 100);

  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { database_id: process.env.NOTION_DATABASE_ID },
      properties: {
        이름: {
          title: [{ text: { content: title } }],
        },
      },
      children: limitedChildren,
    }),
  });

  if (!res.ok) {
    throw new Error("Notion error: " + (await res.text()));
  }
}

(async () => {
  try {
    const issues = await fetchLinear();
    const now = new Date();
    const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const dateStr = kst.toISOString().slice(0, 10);

    let report = await makeDailyReportWithAI(issues, dateStr);
    report = report.replace("{{REMAINING_TASKS}}", remainBlock);
    report = stripKeysOutsideIssue(report);

    await createNotionPage(report);
    console.log("done:", issues.length, "issues");
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
