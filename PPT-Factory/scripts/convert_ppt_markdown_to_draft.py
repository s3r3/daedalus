import json
import re
import sys
from pathlib import Path


SLIDE_SPLIT_RE = re.compile(r"\n## 第\s*(\d+)\s*页\s*([^\n]+)\n")
SUBSECTION_RE = re.compile(r"\n###\s*([^\n]+)\n")


def clean_text(text: str) -> str:
    text = text.replace("\r\n", "\n").strip()
    text = re.sub(r"\n---+\s*$", "", text).strip()
    return text


def find_section(block: str, names: list[str]) -> str:
    matches = list(SUBSECTION_RE.finditer(block))
    for i, match in enumerate(matches):
        name = match.group(1).strip()
        if name in names:
            start = match.end()
            end = matches[i + 1].start() if i + 1 < len(matches) else len(block)
            return clean_text(block[start:end])
    return ""


def make_text_item(headline: str, body: str = "", sub_items: list | None = None) -> dict:
    item = {"item_type": "text", "headline": headline.strip()}
    body = clean_text(body)
    if body:
        item["body"] = body
    if sub_items:
        item["sub_items"] = sub_items
    return item


def parse_content_items(content: str) -> list[dict]:
    content = clean_text(content)
    if not content:
        return []

    items: list[dict] = []
    if re.search(r"\*\*.+?\*\*", content):
        matches = list(re.finditer(r"\*\*(.+?)\*\*", content))
        preface = clean_text(content[: matches[0].start()])
        if preface:
            preface = re.sub(r"^####\s*", "", preface, flags=re.M)
            items.append(make_text_item("页面要点", preface))

        for i, match in enumerate(matches):
            headline = match.group(1).strip()
            start = match.end()
            end = matches[i + 1].start() if i + 1 < len(matches) else len(content)
            rest = clean_text(content[start:end])
            body_lines = []
            sub_items = []

            for line in rest.splitlines():
                stripped = line.strip()
                if not stripped:
                    continue
                if stripped.startswith("####"):
                    body_lines.append(stripped.lstrip("#").strip())
                elif stripped.startswith("- "):
                    sub_items.append(make_text_item(stripped[2:].strip()))
                elif re.match(r"^\d+\.\s+", stripped):
                    sub_items.append(make_text_item(re.sub(r"^\d+\.\s+", "", stripped)))
                else:
                    body_lines.append(stripped)

            body = " ".join(body_lines)
            items.append(make_text_item(headline, body, sub_items or None))
    else:
        paragraph_lines = []
        bullet_items = []
        for line in content.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            if stripped.startswith("- "):
                bullet_items.append(make_text_item(stripped[2:].strip()))
            elif re.match(r"^\d+\.\s+", stripped):
                bullet_items.append(make_text_item(re.sub(r"^\d+\.\s+", "", stripped)))
            else:
                paragraph_lines.append(stripped)

        if paragraph_lines:
            items.append(make_text_item("页面要点", " ".join(paragraph_lines)))
        items.extend(bullet_items)

    return items


def parse_image_item(image_text: str) -> dict | None:
    image_text = clean_text(image_text)
    if not image_text:
        return None

    lines = []
    for line in image_text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("- "):
            stripped = stripped[2:].strip()
        lines.append(stripped)

    if not lines:
        return None

    return {
        "item_type": "visual",
        "headline": "配图建议",
        "image_description": "；".join(lines),
    }


def infer_semantic_type(title: str, subtitle: str, slide_num: int) -> str:
    if slide_num == 1:
        return "Cover"
    if "总结" in title or "创新" in title or "不足" in title or "致谢" in title:
        return "Conclusion"
    if "背景" in title or "科学问题" in title:
        return "Problem"
    if "研究设计" in subtitle or "技术路线" in title:
        return "Solution"
    if "核心结果" in subtitle:
        return "Data"
    return "Generic"


def infer_layout(title: str, subtitle: str, semantic_type: str) -> str:
    if semantic_type == "Cover":
        return "QuoteHero"
    if semantic_type == "Conclusion" and "致谢" in title:
        return "QuoteHero"
    if semantic_type == "Conclusion":
        return "Grid"
    if semantic_type == "Problem":
        return "SplitConstraint"
    if semantic_type == "Solution":
        return "ProcessSteps"
    if semantic_type == "Data":
        return "DataChart"
    return "BulletList"


def build_core_message(talk_text: str, fallback: str) -> str:
    talk_text = clean_text(talk_text)
    if not talk_text:
        return fallback
    return talk_text


def convert_markdown(markdown_text: str) -> dict:
    markdown_text = markdown_text.split("\n## 附：当前已整理好的主要图片路径", 1)[0]
    parts = SLIDE_SPLIT_RE.split(markdown_text)
    slides = []

    for idx in range(1, len(parts), 3):
        slide_num = int(parts[idx])
        if slide_num > 22:
            break

        subtitle = clean_text(parts[idx + 1])
        block = parts[idx + 2]

        title_section = find_section(block, ["页面标题"])
        title = next((line.strip() for line in title_section.splitlines() if line.strip()), subtitle)
        content = find_section(block, ["页面内容"])
        image_text = find_section(block, ["配图建议", "推荐配图"])
        talk_text = find_section(block, ["这一页怎么讲"])

        semantic_type = infer_semantic_type(title, subtitle, slide_num)
        suggested_layout = infer_layout(title, subtitle, semantic_type)
        content_items = parse_content_items(content)
        image_item = parse_image_item(image_text)
        if image_item:
            content_items.append(image_item)

        slides.append(
            {
                "id": f"slide_{slide_num:02d}",
                "semantic_type": semantic_type,
                "title": title,
                "subtitle": subtitle,
                "core_message": build_core_message(talk_text, subtitle),
                "suggested_layout": suggested_layout,
                "content_items": content_items,
            }
        )

    return {
        "project_title": "博士论文答辩：川蛭通络胶囊治疗急性大面积脑梗死的药效物质基础及作用机制研究",
        "presentation_goal": "博士论文答辩汇报",
        "target_audience": "答辩专家、医学研究同行、导师与评审委员",
        "slides": slides,
    }


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: python scripts/convert_ppt_markdown_to_draft.py <input.md> <output.json>")
        return 1

    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])

    markdown_text = input_path.read_text(encoding="utf-8")
    draft = convert_markdown(markdown_text)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(draft, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Wrote {len(draft['slides'])} slides to {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
