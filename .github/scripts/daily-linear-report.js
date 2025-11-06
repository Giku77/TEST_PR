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

// 어제 시각 계산 (UTC 기준)
const now = new Date();
const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

const linearQuery = `
  query DailyIssues($updatedAfter: DateTimeOrDuration!) {
    issues(
      filter: { updatedAt: { gte: $updatedAfter } }
      orderBy: updatedAt
      first: 100
    ) {
      nodes {
        identifier
        title
        url
        state { name }
        assignee { name }
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
      variables: { updatedAfter: yesterday.toISOString() },
    }),
  });
  if (!res.ok) {
    throw new Error("Linear error: " + (await res.text()));
  }
  const json = await res.json();
  return json.data.issues.nodes;
}

async function makeDailyReportWithAI(issues, dateStr) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY missing");
  }

  // 1) 이슈 섹션에 그대로 뿌릴 버전 (키 포함)
  const issueLinesForIssueSection = issues.map((i) => {
    const state = i.state?.name ?? "Unknown";
    const assignee = i.assignee?.name ? `, 담당: ${i.assignee.name}` : "";
    return `- **${i.identifier}** ${i.title} (상태: ${state}${assignee})\n  - ${i.url}`;
  }).join("\n");

  // 2) 사람/상태만 보는 요약 버전 (키 없음)
  const issueLinesForSummary = issues.map((i) => {
    const state = i.state?.name ?? "Unknown";
    const assignee = i.assignee?.name ? `${i.assignee.name}` : "담당자없음";
    return `- ${assignee}: ${i.title} (${state})`;
  }).join("\n");

  const prompt = `
너는 게임 개발 팀의 일간보고를 작성하는 보조 AI야.
아래 "형식"을 지키면서 작성해. 특히 전일/금일/남은 작업에는 이슈 키(DDK-XX)를 쓰지 마.

형식:

# ${dateStr} 일간보고: 6팀 (백민우, 홍지석, 박다인, 박건혁 / 길하영, 김주홍, 이승연)

# 이슈
(여기에 아래 원본 이슈들을 그대로 붙여.)

---

# 전일 보고

## 완료
- 길하영:
\`\`\`r
(어제 끝낸 작업 요약)
\`\`\`
- 김주홍:
\`\`\`r
(어제 끝낸 작업 요약)
\`\`\`
- 이승연:
\`\`\`r
(어제 끝낸 작업 요약)
\`\`\`
- 기타:
\`\`\`r
(담당자 없는 완료)
\`\`\`

## 미완료 (사유, 처리)
- (어제 못 한 것과 이유)

---

# 금일 보고

## 오전
- 이름: 할 일
## 오후
- 이름: 할 일
## (야근)
- 없으면 "없음"

---

# 남은 작업
\`\`\`r
(아직 Todo인 것들 나열)
\`\`\`

참고용 이슈 목록 (이 아래 것은 네가 위 섹션들을 만들 때 참고만 하고 그대로 복사하지 마):

[참고_사람/작업/상태]
${issueLinesForSummary}

보고서의 "이슈" 섹션에는 아래 내용을 그대로 붙여 넣어:

[이슈섹션_원본]
${issueLinesForIssueSection}
`.trim();

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "너는 팀 일간보고를 한국어로 예쁘게 작성하는 비서야. '전일 보고', '금일 보고', '남은 작업' 섹션에서는 이슈 키를 넣지 마." },
        { role: "user", content: prompt }
      ],
      temperature: 0.4,
    }),
  });

  if (!res.ok) {
    throw new Error("OpenAI error: " + await res.text());
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

// AI가 말을 안 듣고 전일/금일에 DDK-를 넣었을 때 강제로 빼는 후처리
function stripKeysOutsideIssue(content) {
  const lines = content.split("\n");
  let inIssue = false;

  return lines.map((line) => {
    const trimmed = line.trim();

    // 섹션 위치 파악
    if (trimmed.startsWith("# 이슈")) {
      inIssue = true;
      return line;
    }
    if (trimmed.startsWith("# ") && !trimmed.startsWith("# 이슈")) {
      // 다른 대제목으로 넘어가면 issue 섹션에서 나온 것
      inIssue = false;
    }

    // 이슈 섹션이 아니고 "- DDK-"로 시작하면 키 잘라내기
    if (!inIssue && trimmed.startsWith("- DDK-")) {
      // "- DDK-38 뭐시기" -> "- 뭐시기" 로
      const withoutKey = line.replace(/- DDK-\d+\s*/i, "- ");
      return withoutKey;
    }

    return line;
  }).join("\n");
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
    const line = raw.replace(/\r$/, ""); // CR 지우기

    // 코드블록 토글
    if (line.trim().startsWith("```")) {
      if (!inCode) {
        // 코드 시작
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
        // 코드 끝
        inCode = false;
      }
      continue;
    }

    if (inCode) {
      // 마지막으로 추가된 code 블록에 텍스트 추가
      const last = children[children.length - 1];
      last.code.rich_text.push({
        type: "text",
        text: { content: line.slice(0, 2000) },
      });
      continue;
    }

    // 헤더들
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
      children.push({
        object: "block",
        type: "divider",
        divider: {},
      });
    } else {
      // 일반 문단
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

  // 노션은 100블록까지만
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
    // AI가 혹시 섹션 아래에 키를 넣었으면 한 번 더 깎기
    report = stripKeysOutsideIssue(report);

    await createNotionPage(report);
    console.log("done:", issues.length, "issues");
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
