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

// 여기에 네 프로젝트 ID 넣어
const REBLOOM_PROJECT_ID = "96080a2d-9568-4992-8093-7a059aab1c3e";

// KST 기준 날짜 헬퍼
function getKSTNow() {
  const now = new Date();
  return new Date(now.getTime() + Number(TZ_OFFSET_HOURS) * 60 * 60 * 1000);
}

// 어제 00:00(KST) → UTC로 다시
const kstNow = getKSTNow();
const kstYesterday = new Date(
  kstNow.getFullYear(),
  kstNow.getMonth(),
  kstNow.getDate() - 1,
  0, 0, 0
);
const yesterdayUTC = new Date(kstYesterday.getTime() - Number(TZ_OFFSET_HOURS) * 60 * 60 * 1000);

// Linear 쿼리
const linearQuery = `
  query DailyIssues($updatedAfter: DateTimeOrDuration!, $projectId: String!) {
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

// 날짜 분류용 헬퍼
function classifyIssues(issues) {
  const kst = getKSTNow();
  const todayStr = kst.toISOString().slice(0, 10); // 2025-11-06
  const yesterday = new Date(kst.getFullYear(), kst.getMonth(), kst.getDate() - 1);

  const doneYesterday = [];
  const todayTargets = [];
  const remaining = [];

  for (const i of issues) {
    const state = i.state?.name ?? "Unknown";

    // 어제 완료
    if (i.completedAt) {
      const comp = new Date(i.completedAt);
      const compKST = new Date(comp.getTime() + Number(TZ_OFFSET_HOURS) * 60 * 60 * 1000);
      const isYesterday =
        compKST.getFullYear() === yesterday.getFullYear() &&
        compKST.getMonth() === yesterday.getMonth() &&
        compKST.getDate() === yesterday.getDate();

      if (isYesterday) {
        doneYesterday.push(i);
        continue;
      }
    }

    // 오늘 해야 하는 것 (dueDate가 오늘이거나, 상태가 진행중)
    if (
      i.dueDate === todayStr ||
      state === "In Progress"
    ) {
      todayTargets.push(i);
      continue;
    }

    // 나머지
    remaining.push(i);
  }

  return { doneYesterday, todayTargets, remaining };
}

async function makeDailyReportWithAI(issues, dateStr) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY missing");
  }

  // 이슈 섹션용 (키 + URL + 짧은 설명)
  const issueLinesForIssueSection = issues.map((i) => {
    const state = i.state?.name ?? "Unknown";
    const assignee = i.assignee?.name ? `, 담당: ${i.assignee.name}` : "";
    const desc = i.description ? `    설명: ${i.description.slice(0, 120)}...` : "";
    return [
      `- **${i.identifier}** ${i.title} (상태: ${state}${assignee})`,
      `  - ${i.url}`,
      desc
    ].filter(Boolean).join("\n");
  }).join("\n");

  // 날짜별 분류
  const { doneYesterday, todayTargets, remaining } = classifyIssues(issues);

  // 아래 3개는 AI가 참고만 하게 넘겨줄 데이터
  const doneText = doneYesterday.map(i => {
    const who = i.assignee?.name ?? "담당자없음";
    return `- ${who}: ${i.title}`;
  }).join("\n") || "없음";

  const todayText = todayTargets.map(i => {
    const who = i.assignee?.name ?? "담당자없음";
    return `- ${who}: ${i.title}`;
  }).join("\n") || "없음";

  const remainText = remaining.map(i => `- ${i.title}`).join("\n") || "없음";

  const prompt = `
너는 게임 개발 팀의 일간보고를 작성하는 보조 AI야.
아래 형식을 그대로 쓰되,
- "이슈" 섹션에는 내가 내려준 원본 목록을 그대로 붙이고
- 그 아래 전일/금일/남은 작업에는 이슈 키를 쓰지 말고 사람/작업만 써.
- 코드블록은 그대로 유지해.

형식:

# ${dateStr} 일간보고: RE:BLOOM

# 이슈
(여기에는 [ISSUE_SECTION]을 그대로)

---

# 전일 보고

## 완료
- 길하영:
\`\`\`r
(여기에 어제 길하영이 한 일)
\`\`\`
- 김주홍:
\`\`\`r
(여기에 어제 김주홍이 한 일)
\`\`\`
- 이승연:
\`\`\`r
(여기에 어제 이승연이 한 일)
\`\`\`
- 기타:
\`\`\`r
(담당자 없는 완료)
\`\`\`

## 미완료 (사유, 처리)
- 어제 못한 것들 정리

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
(앞으로 해야 할 것들)
\`\`\`

[어제 완료 목록]
${doneText}

[오늘 해야 할 것]
${todayText}

[남은 것]
${remainText}

[ISSUE_SECTION]
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

async function createNotionPage(content) { const offset = parseInt(process.env.TZ_OFFSET_HOURS || "9", 10); const now = new Date(); const kstNow = new Date(now.getTime() + offset * 60 * 60 * 1000); const yyyy = kstNow.getUTCFullYear(); const mm = String(kstNow.getUTCMonth() + 1).padStart(2, "0"); const dd = String(kstNow.getUTCDate()).padStart(2, "0"); const title = Linear 일간보고 ${yyyy}-${mm}-${dd}; const lines = content.split("\n"); const children = []; let inCode = false; for (const raw of lines) { const line = raw.replace(/\r$/, ""); // CR 지우기 // 코드블록 토글 if (line.trim().startsWith("
")) {
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
