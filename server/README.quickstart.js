// server/README.quickstart.js (optional, just for you)
// Example curl:
/// curl -X POST http://localhost:8787/api/quest-node \
///  -H "Content-Type: application/json" \
///  -d '{
///    "act":"ACT_I",
///    "questId":"Q1",
///    "thesis":"UR_without_CL",
///    "bankPrimary":"A",
///    "bankConfidence":0.72,
///    "intensity":"standard",
///    "historyIds":["EXP_INTRO_0001"],
///    "sinTags":["panic","overcommitment"],
///    "performanceSummary":{
///      "levels_completed": 6,
///      "avg_time_to_first_move_ms": 820,
///      "invalid_pour_rate": 0.12,
///      "resets_per_level": 0.6
///    },
///    "seed":"player123:ACT_I:Q1:node2"
///  }'
