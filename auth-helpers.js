(function (root, factory) {
  var api = factory();
  root.AuthHelpers = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  function normalizeEmail(email) {
    return String(email || "").trim().toLowerCase();
  }

  function isOwnerEmail(email, ownerEmail) {
    return normalizeEmail(email) === normalizeEmail(ownerEmail);
  }

  return {
    normalizeEmail: normalizeEmail,
    isOwnerEmail: isOwnerEmail
  };
});
