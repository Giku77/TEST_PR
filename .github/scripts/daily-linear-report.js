const {
  LINEAR_API_KEY,
  NOTION_API_KEY,
  NOTION_DATABASE_ID,
  TZ_OFFSET_HOURS = "9",
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

function makeReport(issues) {
  if (!issues.length) return "오늘 변경된 이슈가 없습니다.";
  return issues
    .map((i) => {
      const assignee = i.assignee?.name ? `, 담당: ${i.assignee.name}` : "";
      return `- **${i.identifier}** ${i.title} (상태: ${i.state?.name ?? "?"}${assignee})\n  - ${i.url}`;
    })
    .join("\n");
}

async function makeDailyReportWithAI(issues, dateStr) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY missing");
  }

  // Linear 이슈를 프롬프트용 텍스트로 변환
  const issueLines = issues.map((i) => {
    const state = i.state?.name ?? "Unknown";
    const assignee = i.assignee?.name ? `, 담당: ${i.assignee.name}` : "";
    return `- ${i.identifier} ${i.title} (상태: ${state}${assignee})\n  - ${i.url}`;
  }).join("\n");

  const prompt = `
너는 게임 개발 팀의 일간보고를 작성하는 보조 AI야.
아래 이슈 목록을 보고 한국어로 일간보고 문서를 만들어줘.

형식은 아래처럼 맞춰줘. 비어 있는 부분은 적당히 "없음" 이라고 써.

# ${dateStr} 일간보고: 6팀 (백민우, 홍지석, 박다인, 박건혁 / 길하영, 김주홍, 이승연)

# 이슈
- (여기에 이슈들을 그대로 나열)

---

# 전일 보고

## 완료
- 담당자가 있는 이슈는 담당자 이름 아래에 정리해.
- 담당자가 없는 이슈는 "기타"로 모아.

## 미완료 (사유, 처리)
- 상태가 Todo 또는 In Progress인 것만 간단히 적어.

---

# 금일 보고
- 상태가 In Progress인 이슈를 오늘 작업 예정으로 적어.

---

# 남은 작업
- 상태가 Todo인 이슈만 나열.

아래가 이슈 목록이야:

${issueLines}
`.trim();

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",     // 추천 모델
      messages: [
        { role: "system", content: "너는 팀 일간보고를 한국어로 예쁘게 작성하는 비서야." },
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


async function createNotionPage(content) {
  const offset = parseInt(process.env.TZ_OFFSET_HOURS || "9", 10);
  const now = new Date();
  const kstNow = new Date(now.getTime() + offset * 60 * 60 * 1000);
  const yyyy = kstNow.getUTCFullYear();
  const mm = String(kstNow.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(kstNow.getUTCDate()).padStart(2, "0");
  const title = `Linear 일간보고 ${yyyy}-${mm}-${dd}`;

  const lines = content.split("\n");

  const children = lines.map((raw) => {
    const line = raw.trimEnd(); // 끝 공백 제거

    // h1
    if (line.startsWith("# ")) {
      return {
        object: "block",
        type: "heading_1",
        heading_1: {
          rich_text: [{ type: "text", text: { content: line.slice(2, 2000) } }],
        },
      };
    }
    // h2
    if (line.startsWith("## ")) {
      return {
        object: "block",
        type: "heading_2",
        heading_2: {
          rich_text: [{ type: "text", text: { content: line.slice(3, 2000) } }],
        },
      };
    }
    // h3
    if (line.startsWith("### ")) {
      return {
        object: "block",
        type: "heading_3",
        heading_3: {
          rich_text: [{ type: "text", text: { content: line.slice(4, 2000) } }],
        },
      };
    }

    // 그 외는 그냥 문단
    return {
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
    };
  });

  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.NOTION_API_KEY}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { database_id: process.env.NOTION_DATABASE_ID },
      properties: {
        // 여기 이름은 네 DB 타이틀 속성 이름으로
        "이름": {
          title: [{ text: { content: title } }],
        },
      },
      children,
    }),
  });

  if (!res.ok) {
    throw new Error("Notion error: " + (await res.text()));
  }
}

(async () => {
  try {
    const issues = await fetchLinear();
    // KST 날짜 문자열
    const now = new Date();
    const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const dateStr = kst.toISOString().slice(0, 10); // 2025-09-30 이런 식
    
    const report = await makeDailyReportWithAI(issues, dateStr);
    await createNotionPage(report);
    console.log("done:", issues.length, "issues");
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
