const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function generatePositionBetween(prev, next) {
  const p = prev || "0";
  const n = next || "z";
  let result = "";
  let i = 0;

  while (true) {
    const pChar = p[i] || "0";
    const nChar = n[i] || "z";
    const pVal = BASE62.indexOf(pChar);
    const nVal = BASE62.indexOf(nChar);

    if (nVal - pVal > 1) {
      const midVal = Math.floor((pVal + nVal) / 2);
      result += BASE62[midVal];
      break;
    } else {
      result += pChar;
      if (pVal === nVal && p[i] !== undefined) {
        i++;
      } else {
        result += BASE62[Math.floor(BASE62.length / 2)];
        break;
      }
    }
  }
  return result;
}

export function getFractionalPositionAtIndex(sortedPositions, targetIndex) {
  if (sortedPositions.length === 0) return "M";
  if (targetIndex <= 0) return generatePositionBetween(null, sortedPositions[0]);
  if (targetIndex >= sortedPositions.length) return generatePositionBetween(sortedPositions[sortedPositions.length - 1], null);
  return generatePositionBetween(sortedPositions[targetIndex - 1], sortedPositions[targetIndex]);
}
