# Modèles des contrats d'entretien

Deux fichiers Word, remplacés par ceux du bureau quand ils changent (même nom) :

- `contrat-fosse.docx` : contrat type fosse septique
- `mandat.docx` : mandat de prélèvement SEPA séparé (sans lui, un mandat simple est généré)

Les champs s'écrivent entre doubles accolades, d'un seul tenant (taper `{{client_nom}}` d'un coup,
sans mise en forme au milieu). Un champ vide devient « …………………… ».

| Champ | Contenu |
|---|---|
| `{{numero_contrat}}` | réf. du contrat Dolibarr (brouillon) |
| `{{date_emission}}` | date du jour |
| `{{client_nom}}`, `{{client_representant}}` | nom du client |
| `{{client_adresse}}`, `{{client_code_postal}}`, `{{client_ville}}` | adresse du client |
| `{{client_telephone}}`, `{{client_email}}` | coordonnées |
| `{{site_intervention}}` | adresse complète de la fosse |
| `{{type_bac}}` | volume (ex. 4 m³) |
| `{{couverts}}` | secteur tarifaire |
| `{{frequence}}` | « Vidange tous les 2 ans » |
| `{{acces}}` | moins / plus de 20 m |
| `{{clause_vidange}}` | clause « contrat seul » (finance la prochaine vidange) |
| `{{duree}}`, `{{type_duree}}`, `{{date_debut}}` | 24 mois, reconduction tacite |
| `{{montant_ht}}` | prix de la vidange TTC |
| `{{montant_tva}}`, `{{mensualite}}` | mensualité TTC |
| `{{montant_ttc}}` | total sur 24 mois |
| `{{modalites_paiement}}` | prélèvement SEPA mensuel |
| `{{rum}}` | référence unique du mandat (mandat) |
| `{{fait_a}}`, `{{fait_le}}` | lieu (ville du client), date laissée vide |
| `{{iban}}`, `{{bic}}`, `{{date_signature}}` | laissés vides pour le client |
