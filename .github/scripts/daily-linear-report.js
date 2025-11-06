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

// 이 함수는 이제 안 쓰지만 남겨둠
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
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY missing");
  }

  // 1) "이슈 섹션"에 그대로 뿌릴 버전 (키 포함)
  const issueLinesForIssueSection = issues.map((i) => {
    const state = i.state?.name ?? "Unknown";
    const assignee = i.assignee?.name ? `, 담당: ${i.assignee.name}` : "";
    return `- **${i.identifier}** ${i.title} (상태: ${state}${assignee})\n  - ${i.url}`;
  }).join("\n");

  // 2) 보고서 아래쪽에서 참고할 버전 (키 빼고 사람/상태만)
  const issueLinesForSummary = issues.map((i) => {
    const state = i.state?.name ?? "Unknown";
    const assignee = i.assignee?.name ? `${i.assignee.name}` : "담당자없음";
    return `- ${assignee}: ${i.title} (${state})`;
  }).join("\n");

  const prompt = `
너는 게임 개발 팀의 일간보고를 작성하는 보조 AI야.
아래 형식을 "그대로" 써. 제목은 노션에서 바로 보여지게 하니까 #을 글자 그대로 써도 돼.

형식:

# ${dateStr} 일간보고: 6팀 (백민우, 홍지석, 박다인, 박건혁 / 길하영, 김주홍, 이승연)

# 이슈
(여기에 Linear 이슈 목록을 그대로 붙여. 이 부분에서는 이슈 키(DDK-xx)와 URL을 반드시 포함해.)

---

# 전일 보고

## 완료
- 사람별로 묶어서 bullet로 정리해.
- 여기서는 이슈 키(DDK-xx)는 쓰지 말고 작업 이름만 써.
- 없으면 "없음"이라고 써.

## 미완료 (사유, 처리)
- 상태가 Todo 또는 In Progress인 것만 골라서 한 줄로.
- 여기서도 이슈 키는 쓰지 말고 작업 이름 + 이유만.

---

# 금일 보고

## 오전
- 사람: 할 일
## 오후
- 사람: 할 일
## (야근)
- 없으면 "없음"

---

# 남은 작업
- 아직 Todo인 것만 간단히 bullet로.
- 필요하면 날짜나 우선순위도 적어.

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
        { role: "system", content: "너는 팀 일간보고를 한국어로 예쁘게 작성하는 비서야. 섹션 이름은 반드시 유지해." },
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

  const children = lines.map((line) => ({
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
  }));

  // 노션은 100블록까지만 받음
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

    const report = await makeDailyReportWithAI(issues, dateStr);
    await createNotionPage(report);
    console.log("done:", issues.length, "issues");
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
