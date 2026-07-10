import fs from 'fs';
import path from 'path';

interface IndustryRelation {
  industryId: string;
  overlapRatio: number;
  overlapCount: number;
}

interface ConceptRelation {
  id: string;
  name: string;
  relatedIndustries: IndustryRelation[];
}

interface IndustryEntry {
  id: string;
  name: string;
  leadingStocks: any[];
}

interface ParentIndustry {
  id: string;
  name: string;
  overlapRatio: number;
}

const RELATIONS_FILE = path.resolve(__dirname, '../../data/kg-cache/concept_industry_relations.json');
const INDUSTRIES_FILE = path.resolve(__dirname, '../../data/kg-cache/industries.json');

let relationsMap: Map<string, ConceptRelation> | null = null;
let industriesMap: Map<string, string> | null = null;

function loadData(): void {
  if (relationsMap && industriesMap) return;

  const relations: ConceptRelation[] = JSON.parse(fs.readFileSync(RELATIONS_FILE, 'utf-8'));
  const industries: IndustryEntry[] = JSON.parse(fs.readFileSync(INDUSTRIES_FILE, 'utf-8'));

  relationsMap = new Map(relations.map(r => [r.id, r]));
  industriesMap = new Map(industries.map(i => [i.id, i.name]));
}

export async function getParentIndustries(conceptTsCode: string): Promise<ParentIndustry[]> {
  loadData();
  const relation = relationsMap!.get(conceptTsCode);
  if (!relation) return [];

  return relation.relatedIndustries
    .map(r => {
      const name = industriesMap!.get(r.industryId) || '';
      return { id: r.industryId, name, overlapRatio: r.overlapRatio };
    })
    .filter(p => p.name)
    .sort((a, b) => b.overlapRatio - a.overlapRatio);
}

export async function isParentIndustryHot(
  conceptTsCode: string,
  hotSectorNameSet: Set<string>,
): Promise<{ verified: boolean; names: string[]; matched: string[]; bestRank?: number }> {
  const parents = await getParentIndustries(conceptTsCode);
  const matched: string[] = [];
  let bestRank = Infinity;

  for (const parent of parents) {
    for (const hotName of hotSectorNameSet) {
      if (parent.name === hotName || parent.name.includes(hotName) || hotName.includes(parent.name)) {
        matched.push(parent.name);
        if (bestRank === Infinity) {
          bestRank = 0;
        }
        break;
      }
    }
  }

  return {
    verified: matched.length > 0,
    names: parents.map(p => p.name),
    matched: [...new Set(matched)],
    bestRank: bestRank === Infinity ? undefined : bestRank,
  };
}
